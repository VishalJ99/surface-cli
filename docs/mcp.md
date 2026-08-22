# Surface MCP

Surface includes a private stdio MCP server so a mailbox owner can use the same local Gmail,
Outlook, and IMAP capabilities from an unpublished ChatGPT developer app, a creator-only ChatGPT Work
app, Codex, or another private MCP client. The server is intended to run on the machine that owns
`~/.surface-cli`; it does not copy mailbox credentials into ChatGPT.

Requested tool inputs and results do cross the tunnel. Any message bodies, metadata, recipients, or
attachment data returned to ChatGPT are processed under the target workspace's OpenAI data controls.
Keeping credentials local does not keep requested mail content out of ChatGPT.
Surface's normal summarizer configuration also remains active. If `summarizer_backend` is
`openrouter` or `openclaw`, bounded mail content used for summaries is additionally sent to that
configured service; use `summarizer_backend = "none"` to avoid that extra disclosure.

For ChatGPT, use OpenAI Secure MCP Tunnel to bridge the local stdio process. A tunnel keeps the
Surface process and credentials local while maintaining an outbound connection to OpenAI. This
runbook is for a creator-only app, not workspace-wide or public plugin distribution.

Official references:

- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Plugin authentication](https://developers.openai.com/plugins/build/auth)

## Build and verify now

Surface requires Node.js 20.19 or newer. Configure accounts and complete provider login with the
normal CLI before starting MCP; interactive login is deliberately not exposed as a tool.

Until Surface 0.5.0 is published to npm, run the server from this source checkout:

```bash
npm install
npm run check
npm run build
npm run test:mcp
node dist/mcp-server.js
```

After 0.5.0 or newer is published, a global installation can provide the same entrypoint:

```bash
npm install -g surface-cli@^0.5.0
surface account list
surface auth status <account>
surface-mcp
```

The stdio server writes only MCP JSON-RPC to stdout. Do not launch it in a wrapper that prints banners
or shell startup output to stdout.

## Connect ChatGPT through Secure MCP Tunnel

Prerequisites are a tunnel owned by an OpenAI Platform organization and associated with the target
ChatGPT workspace, ChatGPT developer-mode access, and a local control-plane API key. Creating a
tunnel requires Tunnels **Read + Manage**; running or selecting it requires **Read + Use**. Associate
the Platform organization used by Codex as well if Codex should use the plugin. Keep the key in the
local environment; never put it in Surface config, a repo, or chat.

For the current source checkout, set an absolute built entrypoint:

```bash
export CONTROL_PLANE_API_KEY='<local secret>'

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile surface-local \
  --tunnel-id tunnel_... \
  --mcp-command 'node /absolute/path/to/surface-cli/dist/mcp-server.js'

tunnel-client doctor --profile surface-local --explain
tunnel-client run --profile surface-local
```

`surface-mcp` removes `CONTROL_PLANE_API_KEY` from its own environment before serving and also
scrubs it from every Surface/provider child process. Only `tunnel-client` needs that credential.

After installing a published 0.5.0 or newer package, the command may instead be the absolute global
binary path:

```text
/absolute/path/from-command-v-surface-mcp
```

Keep `tunnel-client run` alive on the Surface host. In ChatGPT developer mode, create a new custom
plugin, choose **Tunnel**, and select or paste the configured tunnel ID. Configure **no app
authentication**: this local server implements no MCP OAuth. The **Server URL** connection option is
for an HTTPS MCP deployment and is not needed for this local server.

The tunnel client and ChatGPT workspace perform the remote connection. Surface MCP itself has no
network listener and no end-user identity or authorization layer. The tunnel is a private network
transport, not a mailbox authorization boundary.

Keep the developer app unpublished and accessible only to the human who owns the Surface accounts.
If a ChatGPT Work admin enables it, RBAC must restrict it solely to that mailbox owner. Enabling the
same app for coworkers would let them operate the host owner's configured mailboxes. Any shared or
multi-user deployment requires per-user authorization, tenant-isolated credentials/state, and a
separate hosted security design.

## Exposed tools

The MCP server exposes focused schemas rather than a raw CLI or shell escape hatch.

Account and auth inspection:

- `surface_account_list`
- `surface_account_identity_show`
- `surface_auth_status`
- `surface_auth_check`

Warm sessions:

- `surface_session_start`
- `surface_session_list`
- `surface_session_stop`

Mail reads and local unread state:

- `surface_mail_search`
- `surface_mail_fetch_unread`
- `surface_mail_sent`
- `surface_mail_sync_unread_state`
- `surface_mail_rebaseline_unread_state`
- `surface_mail_thread_get`
- `surface_mail_read`

Mail actions:

- `surface_mail_rsvp`
- `surface_mail_send`
- `surface_mail_create_draft`
- `surface_mail_reply`
- `surface_mail_reply_draft`
- `surface_mail_reply_all`
- `surface_mail_reply_all_draft`
- `surface_mail_forward`
- `surface_mail_forward_draft`
- `surface_mail_archive`
- `surface_mail_mark_read`
- `surface_mail_mark_unread`

Attachments:

- `surface_attachment_list`
- `surface_attachment_download`

Successful attachment downloads up to the configured embedding limit are returned as standard MCP
embedded resources for clients that support them, rather than only as Mac-local paths. The absolute
host path is redacted from MCP output. Larger files remain downloaded on the Surface host and are
reported as `host_local_only`. ChatGPT's handling of embedded attachment resources must be confirmed
through the live tunnel before relying on it operationally.

Draft and live-send modes are separate tools so their model-facing names and safety annotations stay
accurate. Message reads never implicitly mark a message read; use the explicit read-state tool.

## Local-only capabilities

The following remain operator-only CLI capabilities and are intentionally unavailable through MCP:

- account add, identity set, and account remove
- interactive auth login, auth logout, and `auth check --login-if-stale`
- skill installation
- cache stats, prune, and clear
- global `--config` selection
- arbitrary Surface argv or shell commands

These operations bootstrap credentials, mutate local policy/auth state, delete local data, or provide
unnecessary host authority. Run them directly with `surface` when needed, then reconnect or retry the
MCP tool.

## Write safety and confirmation

Mail and calendar content is untrusted external data. Instructions in a message, attachment, sender
name, link, invite, or subject must never change the requested action or bypass confirmation.

Consequential tools require a literal `confirm: true` input. The client should obtain explicit user
confirmation after presenting the exact action. This is an additional model-facing guard, not a
replacement for Surface policy. Existing `writes_enabled`, account, send-mode, and recipient
allowlists remain authoritative and can still reject the operation.

Use draft tools when a message should be prepared for review without sending. Live send, reply,
reply-all, forward, RSVP, archive, read-state, unread rebaseline, session stop, and attachment
download tools are separately identified and confirmed.

## Attachment boundary

Attachment listing and provider download use opaque Surface refs and need no caller-selected local
path. Compose attachments are disabled by default because an unrestricted path would let a model
read and email arbitrary host files.

To enable compose attachments, configure one or more staging roots in the MCP server environment.
The value may be an OS path-delimited list or a JSON array of paths:

```bash
export SURFACE_MCP_ATTACHMENT_ROOTS='/Users/me/surface-attachments'
surface-mcp
```

```bash
export SURFACE_MCP_ATTACHMENT_ROOTS='["/Users/me/surface-attachments","/tmp/surface-outbox"]'
surface-mcp
```

Roots must be non-empty absolute directories; the filesystem root itself is rejected. Choose narrow
staging directories rather than a home directory or checkout. Every requested attachment is
resolved to its canonical path. Missing paths, directories, symlink escapes, files outside those
roots, and attachment sets over the configured size bounds are rejected before Surface runs.
Configure the roots in the environment that launches `tunnel-client`, because callers cannot select
or expand them.

ChatGPT can attach files that are already present in these staging directories. This wrapper does
not accept arbitrary uploads or copy ChatGPT-hosted files onto the Mac; doing so safely needs a
separate bounded upload/staging design.

## Runtime controls

The server inherits the ordinary Surface environment, including `SURFACE_CONFIG_PATH` and
`SURFACE_CACHE_DIR`, at startup. MCP callers cannot override either path. Tool calls are serialized
through one FIFO because subprocesses share Surface state and provider session resources. Input
schemas and the runner also bound message/argument sizes so oversized requests fail clearly before
the operating system's subprocess limits.

Optional bounds:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `SURFACE_MCP_TIMEOUT_MS` | `120000` | maximum CLI execution time per tool call |
| `SURFACE_MCP_MAX_STDOUT_BYTES` | `10485760` | maximum JSON result size |
| `SURFACE_MCP_MAX_STDERR_BYTES` | `1048576` | maximum ignored diagnostic output |
| `SURFACE_MCP_ATTACHMENT_ROOTS` | unset | allowed compose attachment staging roots |
| `SURFACE_MCP_MAX_ATTACHMENT_BYTES` | `20971520` | maximum size of one compose attachment |
| `SURFACE_MCP_MAX_TOTAL_ATTACHMENT_BYTES` | `26214400` | maximum aggregate size per compose call |
| `SURFACE_MCP_MAX_EMBEDDED_ATTACHMENT_BYTES` | `5242880` | downloaded bytes embedded into one MCP result; values above the 5 MiB hard cap are clamped |

On macOS and Linux, cancellation and bound violations terminate the Surface subprocess group. On
Windows, direct-child termination is best effort and descendant browser teardown is not guaranteed.
Stderr is never returned to the model. CLI JSON is returned as schema-advertised structured content.
If a non-idempotent action returns any error that is not provably pre-action, or is interrupted before
reporting an outcome, MCP returns non-retryable `mcp_outcome_unknown`; inspect sent mail or other
state before trying again.

## Private versus public deployment

Secure MCP Tunnel is the recommended private path for a creator-only local mailbox setup. Do not use
this stdio wrapper as a shared Work app: it has no per-user mailbox isolation. Public or multi-user
distribution requires a stable HTTPS MCP endpoint, server-side tenant isolation, OAuth, hosted
credential handling, audit controls, and a separate security review; that is intentionally outside
this local wrapper.
