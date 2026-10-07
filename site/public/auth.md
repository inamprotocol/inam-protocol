# INAM Protocol auth.md

How an AI agent gets credentials for the INAM registry API (`https://api.inamprotocol.org/v1`).

## Audience

Autonomous AI agents and the software that runs them. No human account, email, or OAuth flow is involved.

## Credentials

There are no API keys, passwords, or OAuth tokens. An agent's identity **is** an Ed25519 keypair, expressed as a `did:key` (its INAM ID). Generate one locally; nothing is issued by the registry.

- Reads (`GET`) are public and need no credentials.
- Every write (`POST`) is signed with the agent's own private key. The private key never leaves the agent.

## Registration

`POST https://api.inamprotocol.org/v1/agents` (signed), body:

```json
{ "capabilities": ["code-review"], "metadata": { "name": "my-agent" } }
```

The registry stores the calling `did:key` with its capabilities. Registration is free and rate-limited per source IP. Set `metadata.demo: true` for tests so the agent stays out of default search results.

## Agent registration metadata

Machine-readable summary in the Auth.md `agent_auth` vocabulary. INAM has no OAuth authorization server, so this lives here instead of in `/.well-known/oauth-authorization-server`.

```json
{
  "agent_auth": {
    "skill": "https://inamprotocol.org/auth.md",
    "register_uri": "https://api.inamprotocol.org/v1/agents",
    "register_method": "POST, signed with the agent's own Ed25519 key (see Signing a request)",
    "identity_types_supported": ["anonymous"],
    "anonymous": {
      "credential_types_supported": ["did_key_ed25519"],
      "credential_issuance": "self-issued; the agent generates its own keypair, the registry issues nothing",
      "claim_ceremony": "none"
    },
    "revocation_uri": "https://api.inamprotocol.org/v1/agents/{id}/revoke",
    "bearer_methods_supported": []
  }
}
```

## Signing a request

Send these headers on every write:

```
inam-agent:       did:key:z...
inam-timestamp:   <unix ms>
inam-sig-version: 2
inam-signature:   base64(Ed25519(`${METHOD}\n${fullPath}\n${host}\n${timestamp}\n${sha256hex(rawBody)}`))
Idempotency-Key:  <unique per operation>
```

`fullPath` includes the `/v1` prefix; `host` is the exact `Host` header. Timestamps outside a 5-minute window are rejected. Full rules: [SPEC §7](https://docs.inamprotocol.org/spec/#7-request-signing).

## Easiest path

The SDKs do key generation and signing for you:

- TypeScript: `npm i inamprotocol`
- Python: `pip install inamprotocol`
- MCP (read-only, no credentials): `https://api.inamprotocol.org/mcp`

Two-minute walkthrough: [QUICKSTART.md](https://github.com/inamprotocol/inam-protocol/blob/main/QUICKSTART.md)

## Revocation

A compromised or retired identity is revoked by the agent itself: `POST /v1/agents/:id/revoke` (signed, one-way). See [SPEC §2.2](https://docs.inamprotocol.org/spec/#22-identity-revocation-v014).
