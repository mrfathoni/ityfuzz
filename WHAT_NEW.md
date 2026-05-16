# What's New

## Build

```bash
export LIBRARY_PATH="/opt/homebrew/opt/z3/lib:$LIBRARY_PATH"
export CPATH="/opt/homebrew/opt/z3/include:$CPATH"
cargo build --release
```

## Files Modified

| File | Change |
|------|--------|
| `rust-toolchain.toml` | `nightly-2024-01-01` → `nightly-2025-01-01` |
| `Cargo.toml` | Z3 static linking optional. Added `static_z3` feature flag |
| `src/main.rs` | Removed stabilized `#![feature(trait_alias)]` |
| `src/evm/onchain/endpoints.rs` | `get_pair()` — replaced `.unwrap()` panic with graceful `warn!()` + empty vec. RPC errors now logged as `WARN`. `set_latest_block_number`/`fetch_blk_hash`/`fetch_blk_timestamp`/`fetch_blk_coinbase`/`fetch_blk_gaslimit` — replaced `.expect()`/`panic!()` with graceful fallbacks |
| `src/evm/blaz/builder.rs` | All `.expect()` on network calls → `match` → log error → `None` |
| `src/evm/tokens/uniswap.rs:237` | `.first().expect(...)` → graceful return of default PairData |
| `src/evm/host.rs` | Added `current_arbitrary_transfers` field. Track ETH value sent to caller |
| `src/evm/vm.rs` | Added `arbitrary_transfers` field to EVMState. Populated from host |
| `src/evm/oracles/arb_transfer.rs` | Fixed type params. Shows `value: X wei` in output |
| `src/evm/oracles/mod.rs` | Added `arb_transfer` module and `ARB_TRANSFER_BUG_IDX` |
| `src/fuzzers/evm_fuzzer.rs` | Instantiate `ArbitraryERC20TransferOracle` when `--detectors arbitrary_call` is set |
| `server/app.js` | Capped `data[]` at 1000 entries (memory leak fix) |
| `server/pairs-server.ts` | **New.** Bun/TypeScript server using DexScreener API to replace dead `pairs-all.infra.fuzz.land` |

## How arb_transfer Works

1. **Tracking** (`src/evm/host.rs`): When a `CALL` opcode executes with `value > 0` and the target is the transaction caller, it records `(caller, pc, value)` in `current_arbitrary_transfers`.

2. **State population** (`src/evm/vm.rs`): At the end of each transaction, `current_arbitrary_transfers` is merged into `post_state.arbitrary_transfers`.

3. **Detection** (`src/evm/oracles/arb_transfer.rs`): The `ArbitraryERC20TransferOracle` checks `post_state.arbitrary_transfers` after each execution. If any transfers exist, it reports an "Arbitrary Transfer" bug with the wei value.

4. **Activation**: Enabled via `--detectors arbitrary_call` flag.

## How Pairs Server Works

`server/pairs-server.ts` listens on port 5003 and proxies requests to DexScreener's free API. Run:
```bash
cd server && bun run pairs-server.ts
```

Then set `PAIRS_SERVER_URL="http://localhost:5003"` when running the fuzzer.
