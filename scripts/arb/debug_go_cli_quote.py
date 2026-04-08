"""Direct Go CLI quote test.

Bypass our Python sign+socket workaround and use the raw Go CLI `quote`
command to submit a quote. This tells us whether the Go CLI produces
bytes the server accepts, or whether its `valid_until` StringFlag/Int64
bug is a deal-breaker.

Usage:
  python -m scripts.arb.debug_go_cli_quote
"""

import os
import signal
import subprocess
import threading
import time

from scripts.arb.rysk_client import RyskMakerClient, RyskRequest
from scripts.arb.config import RYSK_TESTNET_ASSETS


def main():
    client = RyskMakerClient(env="testnet")

    got_rfq = threading.Event()
    rfq_state = {}

    def on_rfq(req: RyskRequest):
        if got_rfq.is_set():
            return
        rfq_state["req"] = req
        got_rfq.set()
        print(f"[rfq] {req.asset_name} strike=${req.strike_float:.2f} qty={req.quantity_float:.2f} id={req.request_id}")

    def on_resp(data):
        print(f"[resp] {data}")

    client.on_request(on_rfq)
    client.on_response(on_resp)
    client.start(subscribe_assets=[RYSK_TESTNET_ASSETS["WETH"]])

    print("Waiting for RFQ...")
    if not got_rfq.wait(timeout=120):
        print("No RFQ received in 120s")
        client.stop()
        return

    req = rfq_state["req"]

    # Invoke the Go CLI quote command directly with a simple price
    price_e18 = str(int(5.0 * 1e18))  # $5/contract
    nonce = str(int(time.time() * 1_000_000))
    valid_until = str(int(time.time()) + 60)

    # Build args via the SDK to match exactly what it'd do
    sdk = client._sdk
    from ryskV12.models import Quote as SdkQuote
    sdk_quote = SdkQuote(
        assetAddress=req.asset,
        chainId=req.chain_id,
        expiry=req.expiry,
        isPut=req.is_put,
        isTakerBuy=req.is_taker_buy,
        maker=client.wallet,
        nonce=nonce,
        price=price_e18,
        quantity=req.quantity,
        strike=req.strike,
        validUntil=int(valid_until),
        usd=req.usd,
        collateralAsset=req.collateral_asset,
    )
    args = sdk.quote_args(client._maker_channel, req.request_id, sdk_quote)

    print(f"[invoke] {client.config.cli_path} {' '.join(args[:20])}...")
    result = subprocess.run(
        [client.config.cli_path] + args,
        capture_output=True,
        text=True,
        timeout=30,
    )
    print(f"[exit] code={result.returncode}")
    print(f"[stdout] {result.stdout!r}")
    print(f"[stderr] {result.stderr!r}")

    # Give the server a moment to respond
    time.sleep(3)
    client.stop()


if __name__ == "__main__":
    main()
