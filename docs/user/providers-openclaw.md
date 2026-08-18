# OpenClaw

This guide is for people who want to talk to a running OpenClaw Gateway from T3 Code. For Codex, see
[Codex](./providers-codex.md). For Claude, see [Claude](./providers-claude.md). For first-time setup,
see [Install T3 Code](./install.md).

OpenClaw is another provider in the model picker, like Claude or Codex. T3 Code does not start
OpenClaw for you, and it does not import chats from Telegram, Home, or the OpenClaw dashboard.

## What You Need

- OpenClaw already running as a Gateway on this machine (or a Gateway you can reach)
- T3 Code on the same machine for the first pairing

T3 Code talks to that Gateway. It does not launch `openclaw gateway` and it does not use
OpenClaw as a project folder.

## I Only Have One Gateway

Use the default OpenClaw provider. T3 Code creates it for you if it is missing.

In Settings, it can stay like this:

```text
Display name: OpenClaw
Gateway URL: ws://127.0.0.1:18789
Bootstrap token: empty, or the Gateway token if pairing cannot start
```

`ws://127.0.0.1:18789` is OpenClaw's usual local port. If your Gateway uses another port or a
Tailscale address, put that URL in **Gateway URL**.

## Pair The Device

T3 Code signs in as a device named `t3-code`, not as the OpenClaw dashboard.

1. Open **Settings** and look at the OpenClaw provider. If it asks to pair, it shows a request id.
2. On the Gateway machine, approve that request:

   ```bash
   openclaw devices list
   openclaw devices approve <requestId>
   ```

3. After approval, T3 Code keeps a device token and does not need the bootstrap token again.

If T3 Code and the Gateway share this machine and the URL is loopback, T3 Code may read the local
Gateway token just to start pairing. After that, revoke access with `openclaw devices`, not by
rotating the Telegram token.

A T3 Code worktree has its own data directory, so it is a **new** device and needs its own approve.

## Start A Thread

1. Open any T3 Code project.
2. Start a new thread and pick **OpenClaw**.
3. Choose the **agent** (`dev`, `archie`, …), then the **model** and **thinking** level.
4. Send a message.

The thread appears in T3 Code only because you created it here. OpenClaw Home, Telegram, and
dashboard sessions stay in OpenClaw.

The agent works in **that agent's OpenClaw workspace**, not in the project folder you have open.
Picking a local folder or Git URL is not how you start OpenClaw.

## Can I Change The Agent Later?

On a new thread, yes. Changing the agent updates the workspace, model, and thinking the way
OpenClaw's own New Session page does.

After the first send, the agent is locked. Model and thinking can still change. To talk to a
different agent, start a new thread.

## Approvals And Questions

If OpenClaw asks to run something or asks you a question, T3 Code shows it in the thread, like
Claude. Allow or answer there. T3 Code does not auto-allow.

Stop in T3 Code stops the current run. It does not delete the OpenClaw session. The OpenClaw
dashboard may still list that session, labeled as T3.

## What This Provider Does Not Do

- It does not list or import existing OpenClaw chats.
- It does not open a folder picker for the agent's working directory.
- It does not run OpenClaw slash commands such as `/new` or `/compact`. `/` in T3 Code is T3 Code's
  own menu. `/new` here means a new T3 Code thread.
- It does not change OpenClaw's exec policy. Permission switches in T3 Code do not YOLO the Gateway.
- Plan mode is hidden. Use thinking instead.
- Images from the composer are sent. Other attachment kinds are rejected.

## I Use A Remote Phone Or Browser

Pair on the machine that runs the T3 Code server. After that, the mobile app and a remote browser
talk to T3 Code as usual. They do not pair with OpenClaw themselves.

## If OpenClaw Shows As Unavailable

1. Confirm the Gateway is running.
2. Confirm **Gateway URL** matches that Gateway (protocol v4).
3. If Settings shows a pairing request id, approve it with `openclaw devices approve`.
4. If the URL is not loopback, paste a bootstrap token and try again.
