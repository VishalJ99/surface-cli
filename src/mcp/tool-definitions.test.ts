import assert from "node:assert/strict";
import test from "node:test";

import {
  getSurfaceMcpToolDefinition,
  listSurfaceMcpToolDefinitions,
  surfaceToolDefinitions,
  surfaceToolDefinitionsByName,
  type SurfaceMcpToolDefinition,
} from "./tool-definitions.js";

const expectedToolNames = [
  "surface_account_list",
  "surface_account_identity_show",
  "surface_auth_status",
  "surface_auth_check",
  "surface_session_start",
  "surface_session_list",
  "surface_session_stop",
  "surface_mail_search",
  "surface_mail_fetch_unread",
  "surface_mail_sent",
  "surface_mail_sync_unread_state",
  "surface_mail_rebaseline_unread_state",
  "surface_mail_thread_get",
  "surface_mail_read",
  "surface_mail_rsvp",
  "surface_mail_send",
  "surface_mail_create_draft",
  "surface_mail_reply",
  "surface_mail_reply_draft",
  "surface_mail_reply_all",
  "surface_mail_reply_all_draft",
  "surface_mail_forward",
  "surface_mail_forward_draft",
  "surface_mail_archive",
  "surface_mail_mark_read",
  "surface_mail_mark_unread",
  "surface_attachment_list",
  "surface_attachment_download",
] as const;

function tool(name: string): SurfaceMcpToolDefinition {
  const definition = getSurfaceMcpToolDefinition(name);
  assert.ok(definition, `missing tool definition: ${name}`);
  return definition;
}

test("exports exactly the reviewed 28-tool Surface MCP surface", () => {
  const actualNames = surfaceToolDefinitions.map((definition) => definition.name);

  assert.equal(surfaceToolDefinitions.length, 28);
  assert.equal(new Set(actualNames).size, actualNames.length);
  assert.deepEqual(actualNames, expectedToolNames);
  assert.deepEqual(listSurfaceMcpToolDefinitions(), surfaceToolDefinitions);
  assert.equal(surfaceToolDefinitionsByName.size, 28);

  const forbiddenFragments = [
    "skill",
    "account_add",
    "account_identity_set",
    "account_remove",
    "auth_login",
    "auth_logout",
    "cache",
    "exec",
    "shell",
  ];
  for (const name of actualNames) {
    for (const fragment of forbiddenFragments) {
      assert.equal(name.includes(fragment), false, `${name} exposes forbidden ${fragment} capability`);
    }
  }
});

test("builds exact deterministic Surface argv for every exported tool", () => {
  const cases: Array<{
    name: string;
    input: Record<string, unknown>;
    expected: string[];
  }> = [
    {
      name: "surface_account_list",
      input: {},
      expected: ["account", "list"],
    },
    {
      name: "surface_account_identity_show",
      input: { account: "work" },
      expected: ["account", "identity", "show", "work"],
    },
    {
      name: "surface_auth_status",
      input: { account: "work" },
      expected: ["auth", "status", "work"],
    },
    {
      name: "surface_auth_check",
      input: { account: "work", interval: 900, due_only: true },
      expected: ["auth", "check", "work", "--interval=900", "--due-only"],
    },
    {
      name: "surface_session_start",
      input: { account: "uni" },
      expected: [
        "session",
        "start",
        "--account=uni",
        "--idle-timeout=3600",
        "--max-age=604800",
      ],
    },
    {
      name: "surface_session_list",
      input: {},
      expected: ["session", "list"],
    },
    {
      name: "surface_session_stop",
      input: { session_id: "sess_01KPNWYN4FX456JA88JBWHYDX0", confirm: true },
      expected: ["session", "stop", "sess_01KPNWYN4FX456JA88JBWHYDX0"],
    },
    {
      name: "surface_mail_search",
      input: {
        account: "work",
        session: "sess_01KPNWYN4FX456JA88JBWHYDX0",
        text: "invoice",
        from: "billing@example.com",
        subject: "overdue",
        mailbox: "inbox",
        labels: ["unread", "finance"],
        limit: 25,
      },
      expected: [
        "mail",
        "search",
        "--account=work",
        "--session=sess_01KPNWYN4FX456JA88JBWHYDX0",
        "--text=invoice",
        "--from=billing@example.com",
        "--subject=overdue",
        "--mailbox=inbox",
        "--label=unread",
        "--label=finance",
        "--limit=25",
      ],
    },
    {
      name: "surface_mail_fetch_unread",
      input: { account: "work", session: "sess_1", limit: 10 },
      expected: [
        "mail",
        "fetch-unread",
        "--account=work",
        "--session=sess_1",
        "--limit=10",
      ],
    },
    {
      name: "surface_mail_sent",
      input: {
        account: "work",
        session: "sess_1",
        thread_ref: "thr_1",
        recipient: "recipient@example.com",
        limit: 5,
      },
      expected: [
        "mail",
        "sent",
        "--account=work",
        "--session=sess_1",
        "--thread=thr_1",
        "--recipient=recipient@example.com",
        "--limit=5",
      ],
    },
    {
      name: "surface_mail_sync_unread_state",
      input: { account: "work", session: "sess_1", limit: 30 },
      expected: [
        "mail",
        "sync-unread-state",
        "--account=work",
        "--session=sess_1",
        "--limit=30",
      ],
    },
    {
      name: "surface_mail_rebaseline_unread_state",
      input: { account: "work", limit: 30, confirm: true },
      expected: [
        "mail",
        "sync-unread-state",
        "--account=work",
        "--limit=30",
        "--rebaseline",
      ],
    },
    {
      name: "surface_mail_thread_get",
      input: { thread_ref: "thr_1", session: "sess_1", refresh: true },
      expected: ["mail", "thread", "get", "thr_1", "--session=sess_1", "--refresh"],
    },
    {
      name: "surface_mail_read",
      input: { message_ref: "msg_1", session: "sess_1", refresh: true },
      expected: ["mail", "read", "msg_1", "--session=sess_1", "--refresh"],
    },
    {
      name: "surface_mail_rsvp",
      input: { message_ref: "msg_1", response: "tentative", confirm: true },
      expected: ["mail", "rsvp", "msg_1", "--response=tentative"],
    },
    {
      name: "surface_mail_send",
      input: {
        account: "work",
        to: ["to@example.com", "second@example.com"],
        cc: ["cc@example.com"],
        bcc: ["bcc@example.com"],
        subject: "Status",
        body: "Attached status.",
        attachment_paths: ["/staging/status.txt", "/staging/chart.pdf"],
        confirm: true,
      },
      expected: [
        "mail",
        "send",
        "--account=work",
        "--to=to@example.com",
        "--to=second@example.com",
        "--cc=cc@example.com",
        "--bcc=bcc@example.com",
        "--subject=Status",
        "--body=Attached status.",
        "--attach=/staging/status.txt",
        "--attach=/staging/chart.pdf",
      ],
    },
    {
      name: "surface_mail_create_draft",
      input: {
        account: "work",
        to: ["to@example.com"],
        subject: "Draft",
        body: "Draft body",
      },
      expected: [
        "mail",
        "send",
        "--account=work",
        "--to=to@example.com",
        "--subject=Draft",
        "--body=Draft body",
        "--draft",
      ],
    },
    {
      name: "surface_mail_reply",
      input: {
        message_ref: "msg_1",
        body: "Reply body",
        cc: ["cc@example.com"],
        bcc: ["bcc@example.com"],
        confirm: true,
      },
      expected: [
        "mail",
        "reply",
        "msg_1",
        "--body=Reply body",
        "--cc=cc@example.com",
        "--bcc=bcc@example.com",
      ],
    },
    {
      name: "surface_mail_reply_draft",
      input: { message_ref: "msg_1", body: "Reply draft" },
      expected: ["mail", "reply", "msg_1", "--body=Reply draft", "--draft"],
    },
    {
      name: "surface_mail_reply_all",
      input: { message_ref: "msg_1", body: "Reply all", confirm: true },
      expected: ["mail", "reply-all", "msg_1", "--body=Reply all"],
    },
    {
      name: "surface_mail_reply_all_draft",
      input: { message_ref: "msg_1", body: "Reply all draft" },
      expected: ["mail", "reply-all", "msg_1", "--body=Reply all draft", "--draft"],
    },
    {
      name: "surface_mail_forward",
      input: {
        message_ref: "msg_1",
        to: ["to@example.com"],
        cc: ["cc@example.com"],
        bcc: ["bcc@example.com"],
        body: "Forward body",
        confirm: true,
      },
      expected: [
        "mail",
        "forward",
        "msg_1",
        "--to=to@example.com",
        "--cc=cc@example.com",
        "--bcc=bcc@example.com",
        "--body=Forward body",
      ],
    },
    {
      name: "surface_mail_forward_draft",
      input: { message_ref: "msg_1", to: ["to@example.com"], body: "Forward draft" },
      expected: [
        "mail",
        "forward",
        "msg_1",
        "--to=to@example.com",
        "--body=Forward draft",
        "--draft",
      ],
    },
    {
      name: "surface_mail_archive",
      input: { message_ref: "msg_1", confirm: true },
      expected: ["mail", "archive", "msg_1"],
    },
    {
      name: "surface_mail_mark_read",
      input: { message_refs: ["msg_1", "msg_2"], confirm: true },
      expected: ["mail", "mark-read", "msg_1", "msg_2"],
    },
    {
      name: "surface_mail_mark_unread",
      input: { message_refs: ["msg_1", "msg_2"], confirm: true },
      expected: ["mail", "mark-unread", "msg_1", "msg_2"],
    },
    {
      name: "surface_attachment_list",
      input: { message_ref: "msg_1" },
      expected: ["attachment", "list", "msg_1"],
    },
    {
      name: "surface_attachment_download",
      input: { message_ref: "msg_1", attachment_id: "att_1", confirm: true },
      expected: ["attachment", "download", "msg_1", "att_1"],
    },
  ];

  assert.equal(cases.length, 28);
  for (const entry of cases) {
    assert.deepEqual(tool(entry.name).buildArgs(entry.input), entry.expected, entry.name);
  }
});

test("consequential tools require confirm true while draft-only tools do not", () => {
  const consequentialInputs: Record<string, Record<string, unknown>> = {
    surface_session_stop: { session_id: "sess_1" },
    surface_mail_rebaseline_unread_state: { account: "work" },
    surface_mail_rsvp: { message_ref: "msg_1", response: "accept" },
    surface_mail_send: {
      account: "work",
      to: ["to@example.com"],
      subject: "Subject",
      body: "Body",
    },
    surface_mail_reply: { message_ref: "msg_1", body: "Body" },
    surface_mail_reply_all: { message_ref: "msg_1", body: "Body" },
    surface_mail_forward: {
      message_ref: "msg_1",
      to: ["to@example.com"],
      body: "Body",
    },
    surface_mail_archive: { message_ref: "msg_1" },
    surface_mail_mark_read: { message_refs: ["msg_1"] },
    surface_mail_mark_unread: { message_refs: ["msg_1"] },
    surface_attachment_download: { message_ref: "msg_1", attachment_id: "att_1" },
  };

  for (const [name, input] of Object.entries(consequentialInputs)) {
    assert.throws(() => tool(name).buildArgs(input), name);
    assert.throws(() => tool(name).buildArgs({ ...input, confirm: false }), name);
  }

  assert.deepEqual(
    tool("surface_mail_create_draft").buildArgs({
      account: "work",
      to: ["to@example.com"],
      subject: "Draft",
      body: "Body",
    }),
    [
      "mail",
      "send",
      "--account=work",
      "--to=to@example.com",
      "--subject=Draft",
      "--body=Body",
      "--draft",
    ],
  );
});

test("schemas reject config escape hatches and mixed read/write flags", () => {
  assert.throws(() => tool("surface_account_list").buildArgs({ config: "/tmp/other.toml" }));
  assert.throws(() => tool("surface_mail_read").buildArgs({
    message_ref: "msg_1",
    mark_read: true,
  }));
  assert.throws(() => tool("surface_mail_search").buildArgs({ account: "work" }));
  assert.throws(() => tool("surface_auth_check").buildArgs({
    account: "work",
    remembered_only: true,
  }));
  assert.throws(() => tool("surface_mail_read").buildArgs({ message_ref: "--config=/tmp/other.toml" }));
  assert.throws(() => tool("surface_account_identity_show").buildArgs({ account: "--config" }));
  assert.throws(() => tool("surface_mail_fetch_unread").buildArgs({ account: "work", limit: 501 }));
});

test("option-looking input values remain atomic and cannot change draft semantics", () => {
  const draft = tool("surface_mail_create_draft").buildArgs({
    account: "work",
    to: ["to@example.com"],
    subject: "--draft",
    body: "--config=/tmp/other.toml",
  });
  assert.deepEqual(draft, [
    "mail",
    "send",
    "--account=work",
    "--to=to@example.com",
    "--subject=--draft",
    "--body=--config=/tmp/other.toml",
    "--draft",
  ]);

  const replyDraft = tool("surface_mail_reply_draft").buildArgs({
    message_ref: "msg_1",
    body: "--bcc=attacker@example.com",
  });
  assert.deepEqual(replyDraft, [
    "mail",
    "reply",
    "msg_1",
    "--body=--bcc=attacker@example.com",
    "--draft",
  ]);

  assert.deepEqual(
    tool("surface_mail_search").buildArgs({
      account: "work",
      text: "--config=/tmp/other.toml",
    }),
    ["mail", "search", "--account=work", "--text=--config=/tmp/other.toml"],
  );
});

test("annotations accurately separate reads, additive writes, and destructive writes", () => {
  const expected: Record<string, [boolean, boolean, boolean]> = {};

  for (const name of [
    "surface_account_list",
    "surface_account_identity_show",
    "surface_session_list",
  ]) {
    expected[name] = [true, false, false];
  }
  for (const name of [
    "surface_mail_search",
    "surface_mail_fetch_unread",
    "surface_mail_sent",
    "surface_mail_thread_get",
    "surface_mail_read",
    "surface_attachment_list",
  ]) {
    expected[name] = [true, false, true];
  }
  for (const name of [
    "surface_auth_status",
    "surface_auth_check",
    "surface_session_start",
    "surface_mail_sync_unread_state",
    "surface_mail_create_draft",
    "surface_mail_reply_draft",
    "surface_mail_reply_all_draft",
    "surface_mail_forward_draft",
    "surface_attachment_download",
  ]) {
    expected[name] = [false, false, true];
  }
  expected.surface_session_stop = [false, true, false];
  for (const name of [
    "surface_mail_rebaseline_unread_state",
    "surface_mail_rsvp",
    "surface_mail_send",
    "surface_mail_reply",
    "surface_mail_reply_all",
    "surface_mail_forward",
    "surface_mail_archive",
    "surface_mail_mark_read",
    "surface_mail_mark_unread",
  ]) {
    expected[name] = [false, true, true];
  }

  assert.equal(Object.keys(expected).length, 28);
  for (const definition of surfaceToolDefinitions) {
    assert.deepEqual(
      [
        definition.annotations.readOnlyHint,
        definition.annotations.destructiveHint,
        definition.annotations.openWorldHint,
      ],
      expected[definition.name],
      definition.name,
    );
  }
});

test("all mail-facing descriptions warn that mail or attachment content is untrusted", () => {
  for (const definition of surfaceToolDefinitions) {
    if (definition.name.startsWith("surface_mail_") || definition.name.startsWith("surface_attachment_")) {
      assert.match(definition.description, /untrusted/i, definition.name);
    }
  }
});
