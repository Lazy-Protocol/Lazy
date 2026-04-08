"""Operational error logging + correlation IDs + heartbeat.

Designed for the Rysk testnet observation period. Every meaningful event
(RFQ received, bid computed, quote submitted, error caught, reconnect
triggered, etc.) gets a structured JSONL line with:

- timestamp + iso
- severity (INFO, WARN, ERROR, CRITICAL)
- category (rfq, quote, connection, settlement, balance, limit)
- correlation_id (traces a single RFQ through bid→submit→response→trade)
- payload (category-specific fields)

This is what Rysk team reviews to confirm we handle errors properly.
Keep entries small, keep the format stable, keep the write synchronous.

Log paths:
- data/testnet-ops.jsonl (append-only, all events)
- data/testnet-heartbeat.json (overwritten, last known state)
- data/testnet-state.json (crash recovery, written on state transitions)
"""

import json
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional


TESTNET_OPS_LOG = "data/testnet-ops.jsonl"
MAINNET_OPS_LOG = "data/mainnet-ops.jsonl"
HEARTBEAT_PATH = "data/testnet-heartbeat.json"
STATE_PATH = "data/testnet-state.json"


# Severity levels
INFO = "INFO"
WARN = "WARN"
ERROR = "ERROR"
CRITICAL = "CRITICAL"


# Error categories (for filtering Rysk team review)
CAT_CONNECTION = "connection"        # WebSocket, daemon, Unix socket issues
CAT_RFQ = "rfq"                      # RFQ receipt, parsing
CAT_BID = "bid"                      # Bid calculation
CAT_QUOTE = "quote"                  # Quote submission
CAT_TRADE = "trade"                  # Trade notifications
CAT_BALANCE = "balance"              # Balance checks, deposits
CAT_LIMIT = "limit"                  # Position limits, risk
CAT_SETTLEMENT = "settlement"        # Friday 9am exercise flow
CAT_HEARTBEAT = "heartbeat"          # Periodic liveness
CAT_LIFECYCLE = "lifecycle"          # Start, stop, crash recovery


class OpsLogger:
    """Thread-safe append-only structured logger.

    Usage:
        ops = OpsLogger(env="testnet")
        corr = ops.new_correlation()
        ops.info(CAT_RFQ, "received", corr, {"request_id": "...", ...})
        ops.error(CAT_QUOTE, "submission_failed", corr, {"error": str(e)})
    """

    def __init__(self, env: str = "testnet", log_path: Optional[str] = None):
        self.env = env
        self.log_path = log_path or (
            TESTNET_OPS_LOG if env == "testnet" else MAINNET_OPS_LOG
        )
        self._ensure_log_dir()

    def _ensure_log_dir(self):
        os.makedirs(os.path.dirname(self.log_path) or ".", exist_ok=True)

    def _write(self, entry: dict):
        try:
            with open(self.log_path, "a") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception as e:
            # Can't log to file, fall back to stderr. Logging must never crash.
            print(f"[ops_log ERROR] {e}", flush=True)

    def _emit(
        self,
        severity: str,
        category: str,
        event: str,
        correlation_id: Optional[str],
        payload: Optional[dict],
    ):
        entry = {
            "timestamp": time.time(),
            "iso": datetime.now(timezone.utc).isoformat(),
            "env": self.env,
            "severity": severity,
            "category": category,
            "event": event,
        }
        if correlation_id:
            entry["correlation_id"] = correlation_id
        if payload:
            entry["payload"] = payload
        self._write(entry)

        # Also print to stdout for interactive observation
        tag = f"[{severity}/{category}]"
        corr = f"({correlation_id[:8]})" if correlation_id else ""
        msg_summary = ""
        if payload:
            # Compact summary of first 3 keys
            keys = list(payload.keys())[:3]
            parts = [f"{k}={str(payload[k])[:60]}" for k in keys]
            msg_summary = " ".join(parts)
        print(f"{tag} {corr} {event} {msg_summary}", flush=True)

    # --- Severity shortcuts ---

    def info(self, category: str, event: str, correlation_id: Optional[str] = None, payload: Optional[dict] = None):
        self._emit(INFO, category, event, correlation_id, payload)

    def warn(self, category: str, event: str, correlation_id: Optional[str] = None, payload: Optional[dict] = None):
        self._emit(WARN, category, event, correlation_id, payload)

    def error(self, category: str, event: str, correlation_id: Optional[str] = None, payload: Optional[dict] = None):
        self._emit(ERROR, category, event, correlation_id, payload)

    def critical(self, category: str, event: str, correlation_id: Optional[str] = None, payload: Optional[dict] = None):
        self._emit(CRITICAL, category, event, correlation_id, payload)

    def exception(self, category: str, event: str, exc: Exception, correlation_id: Optional[str] = None, payload: Optional[dict] = None):
        """Log an exception with its type and message."""
        p = dict(payload or {})
        p["exception_type"] = type(exc).__name__
        p["exception_msg"] = str(exc)
        self._emit(ERROR, category, event, correlation_id, p)

    # --- Correlation IDs ---

    @staticmethod
    def new_correlation() -> str:
        """Generate a correlation id for tracing a single flow."""
        return str(uuid.uuid4())

    # --- Heartbeat ---

    def heartbeat(self, stats: dict):
        """Write the current liveness state to a single file (overwritten each time).

        Used by external monitors or post-crash inspection to see when we
        were last alive and what our state was.
        """
        entry = {
            "timestamp": time.time(),
            "iso": datetime.now(timezone.utc).isoformat(),
            "env": self.env,
            "stats": stats,
        }
        try:
            tmp_path = HEARTBEAT_PATH + ".tmp"
            with open(tmp_path, "w") as f:
                json.dump(entry, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, HEARTBEAT_PATH)
        except Exception as e:
            print(f"[ops_log heartbeat ERROR] {e}", flush=True)

        # Also log to the JSONL stream at INFO
        self._emit(INFO, CAT_HEARTBEAT, "tick", None, stats)

    # --- State persistence (crash recovery) ---

    def persist_state(self, state: dict):
        """Atomically write a state snapshot we can recover from on restart."""
        try:
            tmp_path = STATE_PATH + ".tmp"
            with open(tmp_path, "w") as f:
                json.dump({
                    "timestamp": time.time(),
                    "env": self.env,
                    "state": state,
                }, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, STATE_PATH)
        except Exception as e:
            self._emit(
                ERROR, CAT_LIFECYCLE, "persist_state_failed",
                None, {"error": str(e)},
            )

    @staticmethod
    def load_state() -> Optional[dict]:
        """Read the last persisted state (if any). Returns None if missing."""
        if not os.path.exists(STATE_PATH):
            return None
        try:
            with open(STATE_PATH) as f:
                return json.load(f)
        except Exception:
            return None
