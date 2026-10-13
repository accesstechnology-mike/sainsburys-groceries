# Live test plan

One Linux machine with Bun and the 1Password CLI. One sign-in, then reuse. No browser. If a step exits `needs_human` or `account_flagged`, stop the plan and send the trace. Do not start a second password POST.

Offline smoke, before any network:

```bash
bun install
bun test
bun run typecheck
```

Expected: `bun test` prints all passes and exit 0.

## 1. Move the current session aside

```bash
mkdir -p ~/.sainsburys
if [ -f ~/.sainsburys/session.json ]; then
  mv ~/.sainsburys/session.json ~/.sainsburys/session.json.bak.$(date +%Y%m%d%H%M%S)
fi
rm -f ~/.sainsburys/mfa-resume.json
```

Expected: `whoami` has no session yet.

```bash
bun src/index.ts whoami --debug
```

Expected: stderr starts with `trace: `, then `error: [session_expired]` and exit 10.

## 2. One sign-in

Put `SAINSBURYS_EMAIL` and `SAINSBURYS_PASSWORD` in the 1Password environment. Do not write them into a file in this repo.

```bash
op run -- bun src/index.ts login --debug
```

Expected, happy path: `sign-in: signed-in` and `Session saved to ...`. The trace path is on stderr.

If the password is accepted and MFA is required, the process exits 12 and the first line of the error is `MFA_REQUIRED`. `~/.sainsburys/mfa-resume.json` exists and does not contain the password. Leave that file. In the same shell, with the same `op run` environment, continue once:

```bash
# code written by the account owner, not echoed into the shell history if you can avoid it
op run -- bun src/index.ts login --mfa-file /tmp/sainsburys-otp --debug
# other terminal, after the owner reads the SMS or app code:
printf '%s\n' '<code>' > /tmp/sainsburys-otp
```

Expected: `sign-in: signed-in`. The resume file is removed. A device-trust cookie, if the MFA form had a remember field, is inside `session.json`. `refreshToken` is present if Hydra issued one.

Stop if the exit code is 13 (`akamai_blocked`), 14 (`site_changed`), or 15 (`account_flagged`).

## 3. Reuse

```bash
op run -- bun src/index.ts whoami --json --debug
op run -- bun src/index.ts login --debug
```

Expected: `whoami` JSON has a positive `user_id` (guest `-1002` means the WC cookie exchange did not stick; stop). The second `login` prints `sign-in: reused` and the trace has no `POST` to `/gol/login`.

## 4. Session life

This does not sign in. It runs for 70 minutes so it crosses the roughly one-hour cookie life reported publicly.

```bash
bun scripts/session-life-probe.ts --interval 5m --duration 70m --debug
```

Expected: one JSON object per line. `outcome` is `alive` while the profile stays a real user. `refresh_extended` means a guest or 401 was followed by a successful refresh. `session_died` means refresh did not extend it; the script then exits 10. `akamai_blocked` exits 10 as well. Keep the JSONL.

## 5. Akamai

```bash
bun src/index.ts doctor akamai --json --debug
```

Expected: `plain-fetch` starts with `akamai_blocked`. `impersonated` starts with `session_expired` when logged out (guest JSON) or is a 200 profile when the session from step 2 is still present. Exit 13 only when `impersonated` itself starts with `akamai_blocked`.

## 6. Search

```bash
bun src/index.ts search "oat drink" -n 5 --json --debug
```

Expected: HTTP 200 under impersonation, a `products` array, exit 0. Pick a `product_uid` from this response for the next step. Write it down from the JSON. Do not reuse a uid you did not just see.

## 7. Basket, then put it back

```bash
bun src/index.ts basket view --json --debug
```

Record every `item_uid` and `quantity`. If `slots reservation` (step 8, or run it now) shows a booked slot, `basket add` amends the upcoming order. Say so in the notes.

Choose a `product_uid` from step 6 that is not already a line in this basket. If every search hit is already in the basket, stop. Do not change quantities.

```bash
bun src/index.ts basket add '<product_uid from step 6>' -q 1 --json --debug
```

Expected: one new line, target `basket` or `next-delivery`. Record the new `item_uid`.

```bash
bun src/index.ts basket remove '<new item_uid>' --json --debug
bun src/index.ts basket view --json --debug
```

Expected: the new `item_uid` is gone. Every previous `item_uid` and quantity matches the first `basket view`. If remove fails, stop and fix the basket by hand before anything else.

## 8. Slots

```bash
bun src/index.ts slots list --json --debug
```

Expected: a reservation object and a slot list (array or `{slots: array}`). This plan does not book or cancel.

## 9. Checkout preview

```bash
bun src/index.ts checkout preview --json --debug
```

Expected: a `token` and the basket, slot, and totals. Nothing is purchased.

## 10. Confirm

Do this only after the account owner says yes to placing that exact preview.

Until a HAR is imported, the expected result is a stub:

```bash
bun src/index.ts checkout confirm --token '<token from step 9>' --debug
```

Expected: `error: [checkout_unmapped]` and exit 17. Nothing is posted. A changed basket is `preview_mismatch` (18) instead.

After `bun scripts/import-har.ts <capture.har>`, confirm posts only the keys in the map, filled from the current preview. Card fields exit `payment_challenge` (16) and are not sent.

## 11. Trace check

Open the latest file under `~/.sainsburys/traces/`. Search it for the password and the email. Expected: neither appears. The file mode is 600. Send that file back with the probe JSONL.

`account-flag status` should print `not flagged` at the end. If it prints a flag, automation stays stopped until a person runs `account-flag clear --acknowledge`.
