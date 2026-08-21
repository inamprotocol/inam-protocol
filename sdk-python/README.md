# inamprotocol (Python SDK)

Reference Python client for the INAM Protocol — parity with the TypeScript `InamClient` in `../src/sdk/client.ts`. See [`../SPEC.md`](../SPEC.md) for the full protocol specification.

## Install (development)

```
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -e . pytest   # Windows
# ./.venv/bin/python -m pip install -e . pytest          # macOS/Linux
```

## Test

```
./.venv/Scripts/python.exe -m pytest -v
```

`tests/test_interop.py` is the important one: it checks this SDK's `did:key` encoding, canonical JSON, and Ed25519 signing against fixed values generated once by the TypeScript reference implementation (`../scripts/interop-vectors.ts`). If a change here ever breaks that test, a receipt signed by this SDK would stop verifying against a registry or another SDK written in a different language — that's the whole point of the test.

## Usage

```python
from inamprotocol import InamClient, generate_keypair

keypair = generate_keypair()
client = InamClient("http://localhost:4021", keypair)

profile = client.register_agent(["document-extraction"], {"name": "My Agent"})
print(profile["id"])  # did:key:z...

reputation = client.get_reputation(profile["id"])
```

See `examples/interop_worker.py` for a full worker-side flow (register, link an external identity, submit signed Execution Receipt drafts), and `../scripts/run-interop-demo.sh` for the end-to-end cross-language demo (a TypeScript requester and this Python worker doing real business through the same live registry).
