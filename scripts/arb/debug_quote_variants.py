"""Differential quote submission test.

For each incoming RFQ, submit multiple quote variants back-to-back with
different parameter combinations. Match server responses to variants via
JSON-RPC id suffix and print a summary. Stops after N RFQs.

Variants tested:
  A: Default (our pipeline: 0.98 BS discount, 30s validUntil)
  B: Very low bid ($0.01/contract), 30s validUntil
  C: Default bid, 120s validUntil
  D: Default bid, 30s validUntil, all addresses lowercased
  E: Default bid, 30s validUntil, chainId passed as STRING
  F: Price = 1 wei (absolute minimum), 60s validUntil

Usage:
  python -m scripts.arb.debug_quote_variants --count 2 --underlying WETH
"""

import argparse
import asyncio
import json
import math
import os
import signal
import sys
import threading
import time

from scripts.arb.rysk_client import RyskMakerClient, RyskQuote, RyskRequest
from scripts.arb.testnet_pricer import calculate_testnet_bid, get_spot_testnet
from scripts.arb.config import RYSK_TESTNET_ASSETS


# Mapping rfq_id -> dict of variant submissions and responses
_state = {
    "rfqs_received": 0,
    "variants": {},   # suffix -> variant metadata
    "responses": [],  # list of raw responses
    "done_event": None,
    "target_count": 1,
    "seen_rfqs": set(),
}


def compute_default_price(req: RyskRequest) -> float:
    """Compute the default-path bid price using testnet pricer."""
    os.environ["TESTNET_BID_DISCOUNT"] = "0.98"
    import importlib
    from scripts.arb import testnet_pricer
    importlib.reload(testnet_pricer)
    bid = testnet_pricer.calculate_testnet_bid(request=req)
    return bid.max_bid if bid is not None else 0.01


def build_variant(client, req: RyskRequest, variant: str) -> tuple[RyskQuote, dict]:
    """Return (quote, json_rpc_params_override)."""
    default_price = compute_default_price(req)
    # Baseline quote fields
    q = RyskQuote(
        asset_address=req.asset,
        chain_id=req.chain_id,
        expiry=req.expiry,
        is_put=req.is_put,
        is_taker_buy=req.is_taker_buy,
        maker=client.wallet,
        nonce=str(int(time.time() * 1_000_000)),
        price=str(int(default_price * 1e18)),
        quantity=req.quantity,
        strike=req.strike,
        valid_until=int(time.time()) + 30,
        usd=req.usd,
        collateral_asset=req.collateral_asset,
    )
    override = {}

    if variant == "A":
        pass  # baseline
    elif variant == "B":
        # Very low bid: $0.01/contract
        q = RyskQuote(
            asset_address=q.asset_address,
            chain_id=q.chain_id,
            expiry=q.expiry,
            is_put=q.is_put,
            is_taker_buy=q.is_taker_buy,
            maker=q.maker,
            nonce=str(int(time.time() * 1_000_000) + 1),
            price=str(int(0.01 * 1e18)),
            quantity=q.quantity,
            strike=q.strike,
            valid_until=int(time.time()) + 30,
            usd=q.usd,
            collateral_asset=q.collateral_asset,
        )
    elif variant == "C":
        # validUntil +120s
        q = RyskQuote(
            asset_address=q.asset_address,
            chain_id=q.chain_id,
            expiry=q.expiry,
            is_put=q.is_put,
            is_taker_buy=q.is_taker_buy,
            maker=q.maker,
            nonce=str(int(time.time() * 1_000_000) + 2),
            price=q.price,
            quantity=q.quantity,
            strike=q.strike,
            valid_until=int(time.time()) + 120,
            usd=q.usd,
            collateral_asset=q.collateral_asset,
        )
    elif variant == "D":
        # Lowercase addresses
        q = RyskQuote(
            asset_address=q.asset_address.lower(),
            chain_id=q.chain_id,
            expiry=q.expiry,
            is_put=q.is_put,
            is_taker_buy=q.is_taker_buy,
            maker=q.maker.lower(),
            nonce=str(int(time.time() * 1_000_000) + 3),
            price=q.price,
            quantity=q.quantity,
            strike=q.strike,
            valid_until=int(time.time()) + 30,
            usd=q.usd.lower(),
            collateral_asset=q.collateral_asset.lower(),
        )
    elif variant == "E":
        # chainId as string (override in params)
        q = RyskQuote(
            asset_address=q.asset_address,
            chain_id=q.chain_id,
            expiry=q.expiry,
            is_put=q.is_put,
            is_taker_buy=q.is_taker_buy,
            maker=q.maker,
            nonce=str(int(time.time() * 1_000_000) + 4),
            price=q.price,
            quantity=q.quantity,
            strike=q.strike,
            valid_until=int(time.time()) + 30,
            usd=q.usd,
            collateral_asset=q.collateral_asset,
        )
        override["chainId_as_string"] = True
    elif variant == "F":
        # Price = 1 wei, extra-long validUntil
        q = RyskQuote(
            asset_address=q.asset_address,
            chain_id=q.chain_id,
            expiry=q.expiry,
            is_put=q.is_put,
            is_taker_buy=q.is_taker_buy,
            maker=q.maker,
            nonce=str(int(time.time() * 1_000_000) + 5),
            price="1",
            quantity=q.quantity,
            strike=q.strike,
            valid_until=int(time.time()) + 60,
            usd=q.usd,
            collateral_asset=q.collateral_asset,
        )
    elif variant == "G":
        # Maker address != signer: use a fake maker, sign with our key
        q = RyskQuote(
            asset_address=q.asset_address,
            chain_id=q.chain_id,
            expiry=q.expiry,
            is_put=q.is_put,
            is_taker_buy=q.is_taker_buy,
            maker="0x0000000000000000000000000000000000000001",
            nonce=str(int(time.time() * 1_000_000) + 6),
            price=q.price,
            quantity=q.quantity,
            strike=q.strike,
            valid_until=int(time.time()) + 30,
            usd=q.usd,
            collateral_asset=q.collateral_asset,
        )
    elif variant == "H":
        # Quantity does not match the RFQ's quantity
        adjusted_qty = str(int(q.quantity) + 10**16)  # +0.01
        q = RyskQuote(
            asset_address=q.asset_address,
            chain_id=q.chain_id,
            expiry=q.expiry,
            is_put=q.is_put,
            is_taker_buy=q.is_taker_buy,
            maker=q.maker,
            nonce=str(int(time.time() * 1_000_000) + 7),
            price=q.price,
            quantity=adjusted_qty,
            strike=q.strike,
            valid_until=int(time.time()) + 30,
            usd=q.usd,
            collateral_asset=q.collateral_asset,
        )
    elif variant == "I":
        # Strike != RFQ strike
        adjusted_strike = str(int(q.strike) + 10**8)  # +1
        q = RyskQuote(
            asset_address=q.asset_address,
            chain_id=q.chain_id,
            expiry=q.expiry,
            is_put=q.is_put,
            is_taker_buy=q.is_taker_buy,
            maker=q.maker,
            nonce=str(int(time.time() * 1_000_000) + 8),
            price=q.price,
            quantity=q.quantity,
            strike=adjusted_strike,
            valid_until=int(time.time()) + 30,
            usd=q.usd,
            collateral_asset=q.collateral_asset,
        )
    elif variant == "J":
        # isTakerBuy inverted
        q = RyskQuote(
            asset_address=q.asset_address,
            chain_id=q.chain_id,
            expiry=q.expiry,
            is_put=q.is_put,
            is_taker_buy=not q.is_taker_buy,
            maker=q.maker,
            nonce=str(int(time.time() * 1_000_000) + 9),
            price=q.price,
            quantity=q.quantity,
            strike=q.strike,
            valid_until=int(time.time()) + 30,
            usd=q.usd,
            collateral_asset=q.collateral_asset,
        )
    elif variant == "K":
        # Reuse a past nonce (t-10 minutes)
        q = RyskQuote(
            asset_address=q.asset_address,
            chain_id=q.chain_id,
            expiry=q.expiry,
            is_put=q.is_put,
            is_taker_buy=q.is_taker_buy,
            maker=q.maker,
            nonce="1",
            price=q.price,
            quantity=q.quantity,
            strike=q.strike,
            valid_until=int(time.time()) + 30,
            usd=q.usd,
            collateral_asset=q.collateral_asset,
        )
    elif variant == "L":
        # Maker address LOWERCASED, everything else normal case.
        # Theory: balance lookup is case-sensitive and our checksum
        # address doesn't match the lowercase record in the DB.
        q = RyskQuote(
            asset_address=q.asset_address,
            chain_id=q.chain_id,
            expiry=q.expiry,
            is_put=q.is_put,
            is_taker_buy=q.is_taker_buy,
            maker=q.maker.lower(),
            nonce=str(int(time.time() * 1_000_000) + 10),
            price=q.price,
            quantity=q.quantity,
            strike=q.strike,
            valid_until=int(time.time()) + 30,
            usd=q.usd,
            collateral_asset=q.collateral_asset,
        )
    elif variant == "M":
        # Like L but ALSO with the maker recovered from a lowercase-sig
        # (sign the same quote but verify the sig recovers to lowercase)
        # This is the same as L really since signing produces the same sig.
        # Keep for symmetry / sanity check.
        q = RyskQuote(
            asset_address=q.asset_address,
            chain_id=q.chain_id,
            expiry=q.expiry,
            is_put=q.is_put,
            is_taker_buy=q.is_taker_buy,
            maker=q.maker.lower(),
            nonce=str(int(time.time() * 1_000_000) + 11),
            price="10000000000000000000",  # $10 per contract, small but not zero
            quantity=q.quantity,
            strike=q.strike,
            valid_until=int(time.time()) + 60,
            usd=q.usd,
            collateral_asset=q.collateral_asset,
        )
    return q, override


def submit_variant(client, req: RyskRequest, variant: str):
    """Build, sign, and submit one variant. Returns the custom JSON-RPC id used."""
    q, override = build_variant(client, req, variant)
    signature = client._sign_quote(q)
    suffix = f"{variant}-{int(time.time() * 1000)}"
    rfq_id_in_response = f"{req.request_id}__{suffix}"  # so we can identify it
    params = {
        "assetAddress": q.asset_address,
        "chainId": str(q.chain_id) if override.get("chainId_as_string") else q.chain_id,
        "expiry": int(q.expiry),
        "isPut": q.is_put,
        "isTakerBuy": q.is_taker_buy,
        "maker": q.maker,
        "nonce": q.nonce,
        "price": q.price,
        "quantity": q.quantity,
        "strike": q.strike,
        "signature": signature,
        "validUntil": int(q.valid_until),
        "usd": q.usd,
        "collateralAsset": q.collateral_asset,
    }
    # NOTE: the JSON-RPC id must match the request_id for the server to correlate,
    # BUT for our own response routing we need to identify which variant. We use
    # the same request_id and track variants via submission order.
    payload = {
        "jsonrpc": "2.0",
        "id": req.request_id,
        "method": "quote",
        "params": params,
    }
    client._write_to_maker_socket(payload)
    _state["variants"][suffix] = {
        "variant": variant,
        "sent_at": time.time(),
        "price_e18": q.price,
        "validUntil": q.valid_until,
        "nonce": q.nonce,
        "override": override,
    }
    print(f"[submit {variant}] price={int(q.price)/1e18:.4f} validUntil+{q.valid_until - int(time.time())}s")


def on_rfq(req: RyskRequest):
    if req.request_id in _state["seen_rfqs"]:
        return
    _state["seen_rfqs"].add(req.request_id)
    _state["rfqs_received"] += 1
    print(f"\n=== RFQ #{_state['rfqs_received']} === {req.asset_name} {req.option_type} "
          f"strike=${req.strike_float:.2f} qty={req.quantity_float:.2f} rfq_id={req.request_id}")
    client = _state["client"]
    for variant in ("A", "L", "M"):
        try:
            submit_variant(client, req, variant)
            time.sleep(0.05)  # tiny gap to let server process each
        except Exception as e:
            print(f"[submit {variant}] error: {e}")
    if _state["rfqs_received"] >= _state["target_count"]:
        if _state["done_event"]:
            _state["done_event"].set()


def on_response(data: dict):
    _state["responses"].append({"ts": time.time(), "data": data})
    err = data.get("error", {})
    result = data.get("result")
    code = err.get("code")
    msg_id = data.get("id", "")
    if err:
        print(f"[resp {msg_id}] code={code} msg={err.get('message')}")
    elif result is not None:
        print(f"[resp {msg_id}] result={json.dumps(result)[:200]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--underlying", default="WETH", choices=["WETH", "WBTC"])
    args = parser.parse_args()

    _state["target_count"] = args.count
    _state["done_event"] = threading.Event()

    client = RyskMakerClient(env="testnet")
    _state["client"] = client
    client.on_request(on_rfq)
    client.on_response(on_response)

    asset = RYSK_TESTNET_ASSETS[args.underlying]
    print(f"Connecting, subscribing to {args.underlying} ({asset})")
    client.start(subscribe_assets=[asset])

    try:
        _state["done_event"].wait(timeout=120)
        # Give the server a bit more time to reply to the last batch
        time.sleep(3)
    except KeyboardInterrupt:
        pass
    finally:
        client.stop()

    # Summary
    print("\n" + "=" * 72)
    print("SUMMARY")
    print("=" * 72)
    print(f"RFQs processed: {_state['rfqs_received']}")
    print(f"Variants submitted: {len(_state['variants'])}")
    print(f"Responses received: {len(_state['responses'])}")
    print()
    # Group responses by timing to match variants
    for suffix, meta in _state["variants"].items():
        variant = meta["variant"]
        sent_at = meta["sent_at"]
        # Find the response that came closest in time (within 3s window)
        candidates = [
            r for r in _state["responses"]
            if 0 < r["ts"] - sent_at < 3.0
        ]
        if candidates:
            data = candidates[0]["data"]
            err = data.get("error", {})
            result = data.get("result")
            if err:
                print(f"  {variant}: ERROR code={err.get('code')} msg={err.get('message')!r}")
            else:
                print(f"  {variant}: result={json.dumps(result)[:150]}")
        else:
            print(f"  {variant}: (no response)")


if __name__ == "__main__":
    main()
