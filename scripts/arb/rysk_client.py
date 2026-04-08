"""Rysk V12 maker client wrapper.

Thin layer over the official `ryskV12_py` SDK (which in turn spawns the
`ryskV12` Go CLI as a subprocess for EIP-712 signing and WebSocket IPC).

We do NOT implement the signing or protocol ourselves. The Go CLI handles:
- EIP-712 typed data signing (quote + transfer)
- WebSocket connection + reconnection
- JSON-RPC framing
- Nonce management

We implement:
- Lifecycle orchestration (spawn/stop daemons)
- RFQ observation (log every inbound request, both directions)
- Strategy integration (`calculate_bid` → quote submission)
- Safety rails (direction filter, testnet/mainnet isolation)

Installation prerequisites (one-time setup, NOT done by this code):
1. pip install ryskV12
2. Download https://github.com/rysk-finance/ryskV12-cli/releases/latest
   Place the binary at project-root as `./ryskV12` (or set RYSK_CLI_PATH env)

Environment variables:
- RYSK_PRIVATE_KEY: signing key (Base Sepolia wallet on testnet, HyperEVM on mainnet)
- RYSK_CLI_PATH: override the default ./ryskV12 binary path

Usage:
    client = RyskMakerClient(env="testnet")
    client.start(subscribe_assets=["0xWETH...", "0xWBTC..."])
    client.on_request(handle_rfq)
    # ... long-running listener loop ...
    client.stop()
"""

import json
import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from scripts.arb.config import (
    RYSK_CLI_PATH,
    RYSK_MAINNET_CHAIN_ID,
    RYSK_MAINNET_WS_BASE,
    RYSK_TESTNET_CHAIN_ID,
    RYSK_TESTNET_RPC_URL,
    RYSK_TESTNET_WS_BASE,
)


# ---------------------------------------------------------------------------
# Request / Quote dataclasses (mirror the Rysk SDK models)
# ---------------------------------------------------------------------------

@dataclass
class RyskRequest:
    """Incoming RFQ from Rysk taker. Mirrors the protocol Request schema.

    All integer-like fields stay as strings to preserve precision.
    - quantity: e18 (divide by 10^18 for human readable)
    - strike: e8 (divide by 10^8 for human readable)
    """
    request_id: str           # UUID from Rysk server
    asset: str                # Asset address (0x...)
    asset_name: str           # e.g., "WETH", "WBTC"
    chain_id: int
    expiry: int               # Unix timestamp
    is_put: bool
    is_taker_buy: bool        # True = taker buys (we sell); False = taker sells (we buy)
    quantity: str             # e18
    strike: str               # e8
    taker: str                # Taker address
    usd: str                  # Stablecoin address for premium payment
    collateral_asset: str     # Accepted collateral asset address

    @property
    def quantity_float(self) -> float:
        return float(self.quantity) / 1e18

    @property
    def strike_float(self) -> float:
        return float(self.strike) / 1e8

    @property
    def option_type(self) -> str:
        return "P" if self.is_put else "C"

    @property
    def direction_label(self) -> str:
        return "taker_buys_maker_sells" if self.is_taker_buy else "taker_sells_maker_buys"


@dataclass
class RyskQuote:
    """Outgoing quote we submit in response to an RFQ.

    Matches the ryskV12_py Quote model. All match-request fields must
    echo the Request exactly; only maker-side fields (maker, nonce, price,
    validUntil) are new.
    """
    asset_address: str        # = request.asset
    chain_id: int             # = request.chain_id
    expiry: int               # = request.expiry
    is_put: bool              # = request.is_put
    is_taker_buy: bool        # = request.is_taker_buy (we echo this)
    maker: str                # Our maker address
    nonce: str                # Stringified uint64, unique per quote
    price: str                # e18, per-contract price
    quantity: str             # = request.quantity
    strike: str               # = request.strike
    valid_until: int          # Quote expiry timestamp (unix)
    usd: str                  # = request.usd
    collateral_asset: str     # = request.collateral_asset


@dataclass
class RyskConfig:
    """Per-environment configuration snapshot."""
    env: str
    chain_id: int
    ws_base: str
    rpc_url: str
    cli_path: str


def get_rysk_config(env: str = "testnet") -> RyskConfig:
    """Return the config snapshot for a given environment."""
    if env == "testnet":
        return RyskConfig(
            env="testnet",
            chain_id=RYSK_TESTNET_CHAIN_ID,
            ws_base=RYSK_TESTNET_WS_BASE,
            rpc_url=RYSK_TESTNET_RPC_URL,
            cli_path=os.environ.get("RYSK_CLI_PATH", RYSK_CLI_PATH),
        )
    elif env == "mainnet":
        return RyskConfig(
            env="mainnet",
            chain_id=RYSK_MAINNET_CHAIN_ID,
            ws_base=RYSK_MAINNET_WS_BASE,
            rpc_url=os.environ.get("RYSK_MAINNET_RPC_URL", ""),
            cli_path=os.environ.get("RYSK_CLI_PATH", RYSK_CLI_PATH),
        )
    else:
        raise ValueError(f"Unknown Rysk env: {env}")


# ---------------------------------------------------------------------------
# Maker client
# ---------------------------------------------------------------------------

class RyskMakerClient:
    """Wraps ryskV12_py for our maker pipeline.

    This class defers actual SDK import until start() so that the rest of
    the arb package can import scripts.arb.rysk_client without requiring
    ryskV12_py to be installed (keeps testing cleaner).
    """

    def __init__(
        self,
        env: str = "testnet",
        private_key: Optional[str] = None,
        wallet: Optional[str] = None,
    ):
        self.config = get_rysk_config(env)
        self._load_dotenv()
        self.private_key = private_key or os.environ.get("RYSK_PRIVATE_KEY", "")
        if not self.private_key:
            raise RuntimeError(
                "RYSK_PRIVATE_KEY missing. Set in .env or pass explicitly. "
                "Use the Rysk-funded testnet wallet for env='testnet'."
            )

        # Maker address: explicit arg > env var > derived from private key
        self.wallet = wallet or os.environ.get("RYSK_WALLET", "")
        if not self.wallet:
            try:
                from eth_account import Account
                self.wallet = Account.from_key(self.private_key).address
            except Exception:
                self.wallet = ""

        self._sdk = None
        self._env_obj = None
        self._rfq_callback: Optional[Callable[[RyskRequest], None]] = None
        self._response_callback: Optional[Callable[[dict], None]] = None
        # Use a fresh channel_id per instance to avoid any server-side
        # stale state associated with a reused channel name. The server
        # tracks connection identity via the WebSocket (not the channel
        # name), but reusing the same /tmp/<channel_id>.sock across runs
        # previously left us with an unclear binding state.
        import uuid
        self._maker_channel = f"arb_maker_{uuid.uuid4().hex[:8]}"

        # Background daemon processes and reader threads.
        # Each entry: channel_id -> {proc: Popen, thread: Thread, stop: Event}
        self._daemons: dict[str, dict] = {}

    @staticmethod
    def _load_dotenv():
        """Load .env into os.environ (same pattern as derive_om / perp_client)."""
        env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
        env_path = os.path.abspath(env_path)
        if not os.path.exists(env_path):
            return
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key, value = key.strip(), value.strip()
                if not os.environ.get(key):
                    os.environ[key] = value

    def _ensure_sdk(self):
        """Lazy-init the ryskV12_py SDK."""
        if self._sdk is not None:
            return
        try:
            from ryskV12.client import Rysk, Env
        except ImportError as e:
            raise RuntimeError(
                "ryskV12 SDK not installed. Install with: pip install ryskV12\n"
                "Also download the Go CLI: "
                "https://github.com/rysk-finance/ryskV12-cli/releases/latest"
                f"\nOriginal error: {e}"
            )

        if not os.path.exists(self.config.cli_path):
            raise RuntimeError(
                f"ryskV12 CLI binary not found at {self.config.cli_path}. "
                "Download from https://github.com/rysk-finance/ryskV12-cli/releases/latest"
            )

        self._env_obj = Env.TESTNET if self.config.env == "testnet" else Env.MAINNET

        # The Go CLI's quote/approve/transfer commands pass the private key
        # via --private_key on the command line. Go's hex decoder doesn't
        # accept the 0x prefix, so 0x-prefixed keys cause
        #   "invalid hex character 'x' in private key"
        # and the quote silently never reaches the server. The `connect`
        # command doesn't use --private_key (daemon path is different), so
        # subscription works regardless. Strip the prefix here.
        pk_for_sdk = self.private_key
        if pk_for_sdk.startswith("0x") or pk_for_sdk.startswith("0X"):
            pk_for_sdk = pk_for_sdk[2:]

        self._sdk = Rysk(
            env=self._env_obj,
            private_key=pk_for_sdk,
            v12_cli_path=self.config.cli_path,
        )

    # --- Lifecycle ---

    def _spawn_daemon(self, channel_id: str, uri: str, callback: Callable[[bytes], None]):
        """Spawn a long-running ryskV12 connect subprocess and background reader.

        The SDK's execute_async does this asynchronously, but we need a sync
        interface. We bypass execute_async and spawn Popen directly using the
        same args the SDK would produce via connect_args.

        Removes any stale Unix socket file at /tmp/{channel_id}.sock before
        spawning. The Go CLI binds the socket on startup and silently dies
        on EADDRINUSE if a previous run left the file in place. This bit us
        on 2026-04-07: RFQ subscription channels use deterministic names
        (rfqs_0xb67b... derived from asset address), so back-to-back listener
        restarts kept failing to subscribe even though the maker channel
        (random suffix per launch) was fine. Symptom is a healthy-looking
        listener that prints "Subscribed to RFQs for ..." but never sees an
        RFQ. Verify the whole subscription set is alive after start() with
        `ps aux | grep ryskV12` if RFQs aren't arriving.
        """
        self._ensure_sdk()
        sock_path = f"/tmp/{channel_id}.sock"
        if os.path.exists(sock_path):
            try:
                os.remove(sock_path)
            except OSError as e:
                print(f"[rysk {channel_id}] could not remove stale socket {sock_path}: {e}")
        args = self._sdk.connect_args(channel_id, uri)
        # connect_args returns a list like ["connect", "--channel_id", ..., "--url", ...]
        proc = subprocess.Popen(
            [self.config.cli_path] + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        # Wait briefly so we can detect immediate spawn failures (bad URL,
        # binary missing, port collision the cleanup above didn't catch)
        # instead of returning a "ready" handle that points at a dead pid.
        time.sleep(0.3)
        if proc.poll() is not None:
            try:
                _stdout, stderr = proc.communicate(timeout=1)
                stderr_text = (stderr or b"").decode("utf-8", errors="replace")
            except Exception:
                stderr_text = "(could not read stderr)"
            raise RuntimeError(
                f"ryskV12 daemon for {channel_id} died immediately "
                f"(exit={proc.returncode}). stderr: {stderr_text.strip()}"
            )

        stop_event = threading.Event()

        def _reader():
            try:
                while not stop_event.is_set():
                    line = proc.stdout.readline()
                    if not line:
                        break
                    try:
                        callback(line)
                    except Exception as e:
                        print(f"[rysk {channel_id}] callback error: {e}")
            except Exception as e:
                print(f"[rysk {channel_id}] reader error: {e}")

        thread = threading.Thread(target=_reader, daemon=True, name=f"rysk-{channel_id}")
        thread.start()

        self._daemons[channel_id] = {
            "proc": proc,
            "thread": thread,
            "stop": stop_event,
        }

    def start(self, subscribe_assets: list[str]):
        """Spawn the maker daemon and one RFQ daemon per asset.

        subscribe_assets: list of asset addresses (0x...) to listen on.
        """
        self._ensure_sdk()

        # 1. Maker daemon (for submitting quotes, transfers, balances)
        try:
            self._spawn_daemon(
                self._maker_channel, "maker", self._handle_maker_response,
            )
            print(f"[rysk] Connected maker channel: {self._maker_channel}")
        except Exception as e:
            print(f"[rysk] Failed to connect maker channel: {e}")
            raise

        # Give the daemon a moment to initialize the Unix socket before any
        # subsequent execute() calls try to talk to it.
        time.sleep(1.0)

        # 2. RFQ subscriptions (one per asset)
        for asset in subscribe_assets:
            channel_id = f"rfqs_{asset[:10]}"
            try:
                self._spawn_daemon(
                    channel_id, f"rfqs/{asset}", self._handle_rfq_payload,
                )
                print(f"[rysk] Subscribed to RFQs for {asset} (channel: {channel_id})")
            except Exception as e:
                print(f"[rysk] Failed to subscribe to {asset}: {e}")

    def stop(self):
        """Disconnect all channels and terminate daemon subprocesses."""
        if self._sdk is None:
            return

        # Send disconnect command to each daemon (graceful shutdown)
        for channel_id in list(self._daemons.keys()):
            try:
                self._sdk.execute(self._sdk.disconnect_args(channel_id))
            except Exception as e:
                print(f"[rysk] Error disconnecting {channel_id}: {e}")

        # Terminate the subprocesses and join reader threads
        for channel_id, d in list(self._daemons.items()):
            d["stop"].set()
            try:
                d["proc"].terminate()
                d["proc"].wait(timeout=3)
            except (subprocess.TimeoutExpired, Exception):
                try:
                    d["proc"].kill()
                except Exception:
                    pass
            d["thread"].join(timeout=1)

            # Remove Unix socket file if it lingers
            sock_path = f"/tmp/{channel_id}.sock"
            if os.path.exists(sock_path):
                try:
                    os.remove(sock_path)
                except OSError:
                    pass

        self._daemons.clear()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop()

    # --- Callbacks ---

    def on_request(self, callback: Callable[[RyskRequest], None]):
        """Register a callback to receive parsed RyskRequest objects."""
        self._rfq_callback = callback

    def on_response(self, callback: Callable[[dict], None]):
        """Register a callback to observe raw maker channel responses
        (OK / skill_issue / trade / errors)."""
        self._response_callback = callback

    def _handle_maker_response(self, payload: bytes):
        """Handle responses from the /maker channel."""
        if payload == b"\n" or not payload:
            return
        try:
            data = json.loads(payload)
        except json.JSONDecodeError as e:
            print(f"[rysk maker] JSON decode error: {e}, payload: {payload[:200]}")
            return

        if self._response_callback:
            try:
                self._response_callback(data)
            except Exception as e:
                print(f"[rysk] response callback error: {e}")

    def _handle_rfq_payload(self, payload: bytes):
        """Handle messages from the /rfqs/<asset> channel."""
        if payload == b"\n" or not payload:
            return
        try:
            data = json.loads(payload)
        except json.JSONDecodeError as e:
            print(f"[rysk rfq] JSON decode error: {e}, payload: {payload[:200]}")
            return

        # Debug: log raw RFQ structure until we're sure about the shape
        if os.environ.get("RYSK_DEBUG_RFQ"):
            print(f"[rysk rfq raw] {json.dumps(data)[:500]}", flush=True)

        # Rysk SDK helpers detect the shape - we replicate the check here
        # since importing the helpers lazily is awkward
        request_id = data.get("id")
        result = data.get("result")

        if not isinstance(result, dict):
            # Might be a notification without result, log and return
            return

        # Parse into RyskRequest
        try:
            req = RyskRequest(
                request_id=str(request_id) if request_id is not None else "",
                asset=result.get("asset", ""),
                asset_name=result.get("assetName", ""),
                chain_id=int(result.get("chainId", 0)),
                expiry=int(result.get("expiry", 0)),
                is_put=bool(result.get("isPut", False)),
                is_taker_buy=bool(result.get("isTakerBuy", False)),
                quantity=str(result.get("quantity", "0")),
                strike=str(result.get("strike", "0")),
                taker=result.get("taker", ""),
                usd=result.get("usd", ""),
                collateral_asset=result.get("collateralAsset", ""),
            )
        except Exception as e:
            print(f"[rysk rfq] Failed to parse request: {e}")
            return

        if self._rfq_callback:
            try:
                self._rfq_callback(req)
            except Exception as e:
                print(f"[rysk] rfq callback error: {e}")

    # --- Maker operations ---

    def submit_quote(self, quote: RyskQuote, request_id: str) -> dict:
        """Submit a signed quote in response to an RFQ.

        Bypasses the Go CLI's buggy quote command (valid_until flag type
        mismatch causes signed ValidUntil to always be 0 → server rejects
        with -32003 Internal Error because the quote is already expired).

        We sign the EIP-712 Quote message in Python using eth_account
        and write the resulting JSON-RPC payload directly to the maker
        daemon's Unix socket. Same workaround pattern as deposit/withdraw.

        All 4 address fields (assetAddress, maker, usd, collateralAsset)
        are lowercased before both signing and param construction. Per
        Rysk team (Jib, 2026-04-07): "lowercase the asset address, all
        addresses actually". The server's internal DB lookup is
        case-sensitive and checksum-cased addresses returned -32003
        "Internal Error" from the catch-all handler. The signature and
        the JSON-RPC params must agree on case, so we lowercase at both
        sites.
        """
        # Rebuild the quote with all addresses lowercased, then sign.
        quote = RyskQuote(
            asset_address=quote.asset_address.lower(),
            chain_id=quote.chain_id,
            expiry=quote.expiry,
            is_put=quote.is_put,
            is_taker_buy=quote.is_taker_buy,
            maker=quote.maker.lower(),
            nonce=quote.nonce,
            price=quote.price,
            quantity=quote.quantity,
            strike=quote.strike,
            valid_until=quote.valid_until,
            usd=quote.usd.lower(),
            collateral_asset=quote.collateral_asset.lower(),
        )
        signature = self._sign_quote(quote)

        # JSON-RPC params mirror the Go Quote struct, with signature appended
        params = {
            "assetAddress": quote.asset_address,
            "chainId": self.config.chain_id,
            "expiry": int(quote.expiry),
            "isPut": quote.is_put,
            "isTakerBuy": quote.is_taker_buy,
            "maker": quote.maker,
            "nonce": quote.nonce,
            "price": quote.price,
            "quantity": quote.quantity,
            "strike": quote.strike,
            "signature": signature,
            "validUntil": int(quote.valid_until),
            "usd": quote.usd,
            "collateralAsset": quote.collateral_asset,
        }
        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "quote",
            "params": params,
        }
        self._write_to_maker_socket(payload)
        return {
            "success": True,
            "stdout": f"quote signed and submitted: rfq_id={request_id}",
            "stderr": "",
            "signature": signature,
        }

    def get_balances(self, account: str) -> dict:
        """Query USDC balances via the /maker channel."""
        self._ensure_sdk()
        proc = self._sdk.execute(self._sdk.balances_args(self._maker_channel, account))
        stdout = proc.stdout.read() if hasattr(proc, "stdout") and proc.stdout else b""
        stderr = proc.stderr.read() if hasattr(proc, "stderr") and proc.stderr else b""
        return {
            "stdout": stdout.decode() if isinstance(stdout, bytes) else str(stdout),
            "stderr": stderr.decode() if isinstance(stderr, bytes) else str(stderr),
        }

    def get_positions(self, account: str) -> dict:
        """Query oToken positions via the /maker channel."""
        self._ensure_sdk()
        proc = self._sdk.execute(self._sdk.positions_args(self._maker_channel, account))
        stdout = proc.stdout.read() if hasattr(proc, "stdout") and proc.stdout else b""
        stderr = proc.stderr.read() if hasattr(proc, "stderr") and proc.stderr else b""
        return {
            "stdout": stdout.decode() if isinstance(stdout, bytes) else str(stdout),
            "stderr": stderr.decode() if isinstance(stderr, bytes) else str(stderr),
        }

    def approve_spending(self, amount: str) -> dict:
        """Approve strike-asset spending for the MarginPool.

        Uses the CLI's approve command, which talks directly to the
        RPC (not WebSocket). Needed before first deposit.
        """
        self._ensure_sdk()
        proc = self._sdk.execute(
            self._sdk.approve_args(
                self.config.chain_id,
                amount,
                self.config.rpc_url,
            )
        )
        stdout = proc.stdout.read() if hasattr(proc, "stdout") and proc.stdout else b""
        stderr = proc.stderr.read() if hasattr(proc, "stderr") and proc.stderr else b""
        return {
            "stdout": stdout.decode() if isinstance(stdout, bytes) else str(stdout),
            "stderr": stderr.decode() if isinstance(stderr, bytes) else str(stderr),
        }

    # ------------------------------------------------------------------
    # Transfer workaround - bypass the Go CLI's buggy transfer command
    #
    # ryskV12-cli v3.0.1 has a bug: transfer.go reads c.String("user")
    # but the --user flag is not declared in the Flags list, so the Go
    # binary always sees user="" which breaks EIP-712 signing. This
    # workaround sidesteps the binary for transfer ops only - we sign
    # the EIP-712 typed data ourselves in Python (using eth_account,
    # which is the same crypto library geth uses under the hood) and
    # write the resulting JSON-RPC message directly to the Unix socket
    # that the running /maker daemon is listening on.
    #
    # The daemon (spawned via the Go CLI's `connect` command, which is
    # unaffected by the bug) forwards anything written to the socket
    # straight to the Rysk WebSocket. Our Python signing just replaces
    # the broken Go signing path for this one command.
    #
    # See docs/OPTIONS_ARB_STRATEGY.md and memory for context.
    # ------------------------------------------------------------------

    # Rysk verifying contracts per chain (from chain.go)
    _RYSK_CONTRACTS = {
        84532: "0x0ff34dd648b68f09b199b60b91442e750fd13fdc",  # Base Sepolia
        8453:  "0xe33a517dfef3d582f6eb94276e8d514f835a1401",  # Base mainnet
        999:   "0x8c8bcb6d2c0e31c5789253ecc8431ca6209b4e35",  # HyperEVM mainnet
        998:   "0x0122db8Ed9B9B49F3FD8774d93773C2e2A564E81",  # HyperEVM testnet
        10143: "0x3b87932046bc3e1bb63c13aba1306f9d398a9cc6",  # Monad testnet
        1:     "0x0000000000000000000000000000000000000000",  # Ethereum (unused)
    }

    def _build_quote_eip712(self, quote: "RyskQuote") -> dict:
        """Construct the EIP-712 typed data for a Quote message.

        Matches the schema in ryskV12-cli/eip712.go EIP712_TYPES["Quote"]
        exactly, in the order the Go CLI defines it. Field ordering
        matters for the EIP-712 type hash.

        Note: the Go CLI's quote.go has a bug where valid_until is read
        as Int64 from a StringFlag, causing ValidUntil to always be 0
        in the signed message. We avoid the Go CLI entirely for quoting
        by signing here and writing to the maker socket directly, the
        same workaround pattern we use for transfer.
        """
        verifying_contract = self._RYSK_CONTRACTS.get(self.config.chain_id)
        if not verifying_contract:
            raise RuntimeError(
                f"No Rysk verifying contract configured for chain {self.config.chain_id}"
            )

        return {
            "domain": {
                "name": "rysk",
                "version": "0.0.0",
                "chainId": self.config.chain_id,
                "verifyingContract": verifying_contract,
            },
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"},
                ],
                "Quote": [
                    {"name": "assetAddress", "type": "address"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "isPut", "type": "bool"},
                    {"name": "strike", "type": "uint256"},
                    {"name": "expiry", "type": "uint64"},
                    {"name": "maker", "type": "address"},
                    {"name": "nonce", "type": "uint64"},
                    {"name": "price", "type": "uint256"},
                    {"name": "quantity", "type": "uint256"},
                    {"name": "isTakerBuy", "type": "bool"},
                    {"name": "validUntil", "type": "uint64"},
                    {"name": "usd", "type": "address"},
                    {"name": "collateralAsset", "type": "address"},
                ],
            },
            "primaryType": "Quote",
            "message": {
                "assetAddress": quote.asset_address,
                "chainId": self.config.chain_id,
                "isPut": quote.is_put,
                "strike": int(quote.strike),
                "expiry": int(quote.expiry),
                "maker": quote.maker,
                "nonce": int(quote.nonce),
                "price": int(quote.price),
                "quantity": int(quote.quantity),
                "isTakerBuy": quote.is_taker_buy,
                "validUntil": int(quote.valid_until),
                "usd": quote.usd,
                "collateralAsset": quote.collateral_asset,
            },
        }

    def _sign_quote(self, quote: "RyskQuote") -> str:
        """Sign a Quote EIP-712 message with the maker's private key.

        Returns a hex signature string starting with 0x.
        """
        from eth_account import Account
        from eth_account.messages import encode_typed_data

        typed = self._build_quote_eip712(quote)
        signable = encode_typed_data(full_message=typed)
        signed = Account.sign_message(signable, private_key=self.private_key)
        return signed.signature.hex() if signed.signature.hex().startswith("0x") \
            else "0x" + signed.signature.hex()

    def _build_transfer_eip712(
        self,
        asset: str,
        amount: str,
        is_deposit: bool,
        nonce: str,
    ) -> dict:
        """Construct the EIP-712 typed data for a Transfer message.

        Matches the schema in ryskV12-cli/eip712.go EIP712_TYPES["Transfer"]
        and the domain from createEIP712Domain() (name="rysk", version="0.0.0").
        """
        verifying_contract = self._RYSK_CONTRACTS.get(self.config.chain_id)
        if not verifying_contract:
            raise RuntimeError(
                f"No Rysk verifying contract configured for chain {self.config.chain_id}"
            )

        return {
            "domain": {
                "name": "rysk",
                "version": "0.0.0",
                "chainId": self.config.chain_id,
                "verifyingContract": verifying_contract,
            },
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"},
                ],
                "Transfer": [
                    {"name": "user", "type": "address"},
                    {"name": "asset", "type": "address"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "amount", "type": "uint256"},
                    {"name": "isDeposit", "type": "bool"},
                    {"name": "nonce", "type": "uint64"},
                ],
            },
            "primaryType": "Transfer",
            "message": {
                "user": self.wallet,
                "asset": asset,
                "chainId": self.config.chain_id,
                "amount": int(amount),
                "isDeposit": is_deposit,
                "nonce": int(nonce),
            },
        }

    def _sign_transfer(
        self,
        asset: str,
        amount: str,
        is_deposit: bool,
        nonce: str,
    ) -> str:
        """Sign a Transfer EIP-712 message with the maker's private key.

        Returns a hex signature string starting with 0x.
        """
        from eth_account import Account
        from eth_account.messages import encode_typed_data

        typed = self._build_transfer_eip712(asset, amount, is_deposit, nonce)
        signable = encode_typed_data(full_message=typed)
        signed = Account.sign_message(signable, private_key=self.private_key)

        # The Go CLI does sig[64] += 27 after crypto.Sign, which produces a v
        # of 27 or 28. eth_account.sign_message already returns v normalized
        # to 27/28 (the Ethereum standard) so we just read the canonical hex.
        return signed.signature.hex() if signed.signature.hex().startswith("0x") \
            else "0x" + signed.signature.hex()

    def _write_to_maker_socket(self, payload: dict):
        """Write a JSON-RPC payload directly to the maker daemon's Unix socket.

        The connect command (spawned in start()) listens on
        /tmp/<channel_id>.sock and forwards anything written there
        (newline-terminated) to the Rysk WebSocket. See ryskV12-cli/
        connect.go writeToSocket() for the expected format.
        """
        import socket

        sock_path = f"/tmp/{self._maker_channel}.sock"
        if not os.path.exists(sock_path):
            raise RuntimeError(
                f"Maker Unix socket not found at {sock_path}. "
                "Did you call start()?"
            )

        data = json.dumps(payload).encode() + b"\n"

        if os.environ.get("RYSK_DEBUG_SOCKET"):
            print(f"[rysk socket write] {data.decode().rstrip()}", flush=True)

        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.connect(sock_path)
            s.sendall(data)
        finally:
            s.close()

    def deposit(self, asset: str, amount: str, nonce: Optional[str] = None) -> dict:
        """Deposit into the MarginPool.

        Bypasses the buggy Go CLI transfer command. Signs EIP-712 in Python
        and writes directly to the maker daemon's Unix socket.
        """
        if nonce is None:
            nonce = str(int(time.time() * 1000))

        signature = self._sign_transfer(asset, amount, is_deposit=True, nonce=nonce)
        payload = {
            "jsonrpc": "2.0",
            "id": f"deposit-{nonce}",
            "method": "deposit",
            "params": {
                "user": self.wallet,
                "asset": asset,
                "chainId": self.config.chain_id,
                "amount": amount,
                "isDeposit": True,
                "nonce": nonce,
                "signature": signature,
            },
        }
        self._write_to_maker_socket(payload)
        return {
            "stdout": f"deposit signed and submitted: id=deposit-{nonce}",
            "stderr": "",
            "signature": signature,
            "nonce": nonce,
        }

    def withdraw(self, asset: str, amount: str, nonce: Optional[str] = None) -> dict:
        """Withdraw from the MarginPool.

        Same Python-signed + direct-socket workaround as deposit.
        """
        if nonce is None:
            nonce = str(int(time.time() * 1000))

        signature = self._sign_transfer(asset, amount, is_deposit=False, nonce=nonce)
        payload = {
            "jsonrpc": "2.0",
            "id": f"withdraw-{nonce}",
            "method": "withdraw",
            "params": {
                "user": self.wallet,
                "asset": asset,
                "chainId": self.config.chain_id,
                "amount": amount,
                "isDeposit": False,
                "nonce": nonce,
                "signature": signature,
            },
        }
        self._write_to_maker_socket(payload)
        return {
            "stdout": f"withdraw signed and submitted: id=withdraw-{nonce}",
            "stderr": "",
            "signature": signature,
            "nonce": nonce,
        }
