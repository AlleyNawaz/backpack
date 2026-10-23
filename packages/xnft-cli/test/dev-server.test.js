const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

if (process.env.XNFT_TEST_CHILD) {
  // Use an ephemeral port, preserving the real server's host binding and routes.
  const portPath = require.resolve("../simulatorPort");
  require(portPath);
  require.cache[portPath].exports = 0;
  const express = require("express");
  const listen = express.application.listen;
  express.application.listen = function (...args) {
    const server = listen.apply(this, args);
    server.on("listening", () => process.send(server.address()));
    return server;
  };
  process.argv = [
    process.execPath,
    require.resolve("../index"),
    ...JSON.parse(process.env.XNFT_TEST_ARGS),
  ];
  require("../index");
} else {
  async function start(t, cwd, args) {
    const child = fork(__filename, [], {
      cwd,
      env: {
        ...process.env,
        XNFT_TEST_CHILD: "1",
        XNFT_TEST_ARGS: JSON.stringify(args),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    });
    return new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`CLI exited (${code}): ${output}`))
      );
    });
  }

  function localUrl(address, pathname) {
    const host =
      address.family === "IPv6" ? `[${address.address}]` : address.address;
    return `http://${host}:${address.port}${pathname}`;
  }

  test(
    "web simulator serves assets only on a loopback listener",
    { timeout: 30000 },
    async (t) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xnft-server-test-"));
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      await fs.mkdir(path.join(dir, "web-build"));
      await fs.writeFile(
        path.join(dir, "web-build", "index.html"),
        "<p>simulator asset</p>"
      );
      await fs.writeFile(
        path.join(dir, "xnft.json"),
        JSON.stringify({
          kind: "app",
          storage: "aws",
          name: "Test",
          version: "0.1.0",
          description: "Test simulator app",
          website: "https://example.invalid",
          contact: "test@example.invalid",
          icon: { lg: "https://example.invalid/icon.png" },
          entrypoints: { default: { web: "./web-build/index.html" } },
        })
      );
      const address = await start(t, dir, ["web"]);
      assert.ok(
        ["127.0.0.1", "::1"].includes(address.address),
        `unexpected listener: ${address.address}`
      );
      const response = await fetch(localUrl(address, "/web-build/index.html"));
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "<p>simulator asset</p>");
    }
  );

  test(
    "iframe simulator redirects only on a loopback listener",
    { timeout: 30000 },
    async (t) => {
      const destination = "http://localhost:19006/example";
      const address = await start(t, os.tmpdir(), ["--iframe", destination]);
      assert.ok(
        ["127.0.0.1", "::1"].includes(address.address),
        `unexpected listener: ${address.address}`
      );
      const response = await fetch(localUrl(address, "/"), {
        redirect: "manual",
      });
      assert.equal(response.status, 301);
      assert.equal(response.headers.get("location"), destination);
    }
  );
}
