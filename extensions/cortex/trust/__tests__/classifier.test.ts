/**
 * ActionClassifier unit tests
 */

import { describe, expect, it } from "vitest";
import { classify } from "../classifier.js";

describe("ActionClassifier", () => {
  // Tier 1
  it("classifies Read as tier 1 read_file", () => {
    expect(classify("Read", { path: "/tmp/foo.txt" })).toEqual({ tier: 1, category: "read_file" });
  });

  it("classifies exec ls as tier 1 exec_status", () => {
    expect(classify("exec", { command: "ls -la /tmp" })).toEqual({
      tier: 1,
      category: "exec_status",
    });
  });

  it("classifies exec cat as tier 1", () => {
    expect(classify("exec", { command: "cat /etc/hostname" })).toEqual({
      tier: 1,
      category: "exec_status",
    });
  });

  it("classifies exec git status as tier 1", () => {
    expect(classify("exec", { command: "git status" })).toEqual({
      tier: 1,
      category: "exec_status",
    });
  });

  it("classifies cortex_stm as tier 1", () => {
    expect(classify("cortex_stm", {})).toEqual({ tier: 1, category: "cortex_query" });
  });

  it("classifies web_search as tier 1", () => {
    expect(classify("web_search", { query: "test" })).toEqual({ tier: 1, category: "web_search" });
  });

  it("classifies synapse inbox as tier 1", () => {
    expect(classify("synapse", { action: "inbox" })).toEqual({ tier: 1, category: "synapse_read" });
  });

  // Tier 2
  it("classifies Write to .ts file as tier 2 write_file", () => {
    expect(classify("Write", { path: "/tmp/foo.ts" })).toEqual({ tier: 2, category: "write_file" });
  });

  it("classifies cortex_add as tier 2", () => {
    expect(classify("cortex_add", { content: "test" })).toEqual({
      tier: 2,
      category: "cortex_write",
    });
  });

  it("classifies synapse send as tier 2", () => {
    expect(classify("synapse", { action: "send" })).toEqual({ tier: 2, category: "synapse_send" });
  });

  it("classifies sessions_spawn as tier 2", () => {
    expect(classify("sessions_spawn", { task: "test" })).toEqual({
      tier: 2,
      category: "session_spawn",
    });
  });

  it("classifies unknown exec command as tier 2", () => {
    expect(classify("exec", { command: "pnpm install something" })).toEqual({
      tier: 2,
      category: "write_file",
    });
  });

  // Tier 3
  it("classifies gateway restart as tier 3", () => {
    expect(classify("gateway", { action: "restart" })).toEqual({
      tier: 3,
      category: "gateway_action",
    });
  });

  it("classifies systemctl restart as tier 3", () => {
    expect(classify("exec", { command: "systemctl restart signal-cli" })).toEqual({
      tier: 3,
      category: "service_restart",
    });
  });

  it("classifies Write to .json as tier 3 config_change", () => {
    expect(classify("Write", { path: "/etc/config.json" })).toEqual({
      tier: 3,
      category: "config_change",
    });
  });

  it("classifies cron update as tier 3", () => {
    expect(classify("cron", { action: "update" })).toEqual({ tier: 3, category: "cron_modify" });
  });

  it("classifies exec npm publish as tier 3", () => {
    expect(classify("exec", { command: "npm publish" })).toEqual({ tier: 3, category: "deploy" });
  });

  // Tier 4
  it("classifies augur trade as tier 4", () => {
    expect(classify("exec", { command: "augur-trading trade BTC" })).toEqual({
      tier: 4,
      category: "financial_augur",
    });
  });

  it("classifies crypto transfer as tier 4", () => {
    expect(classify("exec", { command: "crypto transfer send-eth" })).toEqual({
      tier: 4,
      category: "financial_crypto",
    });
  });

  // Default fallback
  it("classifies unknown tool as tier 2 write_file", () => {
    expect(classify("some_new_tool", {})).toEqual({ tier: 2, category: "write_file" });
  });

  // ── C1 Security Tests — financial hardcap bypass prevention ─────────────
  // These tests verify that Tier 4 financial detection fires BEFORE the exec
  // read-only shortcut, so compound commands cannot hide behind a read prefix.

  it("C1: exec with ls prefix before augur trade command → tier 4 financial_augur", () => {
    expect(classify("exec", { command: "ls && augur trade --live" })).toMatchObject({
      tier: 4,
      category: "financial_augur",
    });
  });

  it("C1: exec with echo prefix before crypto transfer → tier 4 financial_crypto", () => {
    expect(classify("exec", { command: "echo ok; coinbase transfer 1 BTC" })).toMatchObject({
      tier: 4,
      category: "financial_crypto",
    });
  });

  it("C1: exec with cat prefix before stripe charge → tier 4 financial_stripe", () => {
    expect(
      classify("exec", { command: "cat /etc/hostname && stripe charge create" }),
    ).toMatchObject({ tier: 4, category: "financial_stripe" });
  });

  it("C1: standalone ls without financial payload remains tier 1 (read-only path unaffected)", () => {
    expect(classify("exec", { command: "ls -la /tmp" })).toMatchObject({
      tier: 1,
      category: "exec_status",
    });
  });
});
