/**
 * @fileoverview Shared parameter extraction utilities for channel plugins.
 *
 * This module provides common parameter extraction patterns used across
 * multiple channel plugins to reduce code duplication and improve maintainability.
 */

import { readStringParam } from "../../agents/tools/common.js";

/**
 * Standard parameters for sending messages across all channel plugins.
 */
export interface StandardSendParams {
  /** Target recipient (user, channel, etc.) - always required */
  to: string;
  /** Message content/text - optional if media is provided */
  content?: string;
  /** Media URL or file path - optional */
  mediaUrl?: string;
  /** Thread ID for threaded messages - optional */
  threadId?: string;
  /** Reply-to message ID - optional */
  replyTo?: string;
  /** Filename for media attachments - optional */
  filename?: string;
}

/**
 * Parameters for message actions (react, edit, delete, etc.).
 */
export interface MessageActionParams {
  /** Message ID to act upon - always required */
  messageId: string;
  /** Emoji for reactions - optional, allows empty strings */
  emoji?: string;
}

/**
 * Parameters for guild/server administration actions (Discord).
 */
export interface GuildAdminParams {
  /** Guild/server ID - always required */
  guildId: string;
  /** User ID - optional */
  userId?: string;
  /** Channel ID - optional */
  channelId?: string;
}

/**
 * Extract standard send message parameters from tool params.
 *
 * @param params - Raw tool parameters
 * @returns Normalized send parameters with consistent naming
 */
export function readStandardSendParams(params: Record<string, unknown>): StandardSendParams {
  return {
    to: readStringParam(params, "to", { required: true }),
    content: readStringParam(params, "message", { allowEmpty: true }),
    mediaUrl: readStringParam(params, "media", { trim: false }),
    threadId: readStringParam(params, "threadId"),
    replyTo: readStringParam(params, "replyTo"),
    filename: readStringParam(params, "filename"),
  };
}

/**
 * Extract message action parameters from tool params.
 *
 * @param params - Raw tool parameters
 * @returns Normalized message action parameters
 */
export function readMessageActionParams(params: Record<string, unknown>): MessageActionParams {
  return {
    messageId: readStringParam(params, "messageId", { required: true }),
    emoji: readStringParam(params, "emoji", { allowEmpty: true }),
  };
}

/**
 * Extract guild administration parameters from tool params (Discord-specific).
 *
 * @param params - Raw tool parameters
 * @returns Normalized guild admin parameters
 */
export function readGuildAdminParams(params: Record<string, unknown>): GuildAdminParams {
  return {
    guildId: readStringParam(params, "guildId", { required: true }),
    userId: readStringParam(params, "userId"),
    channelId: readStringParam(params, "channelId"),
  };
}

/**
 * Extract enhanced send parameters with additional fields (Telegram-specific).
 * Extends StandardSendParams with platform-specific options.
 *
 * @param params - Raw tool parameters
 * @returns Enhanced send parameters for Telegram
 */
export function readEnhancedSendParams(params: Record<string, unknown>) {
  const standard = readStandardSendParams(params);

  return {
    ...standard,
    caption: readStringParam(params, "caption", { allowEmpty: true }),
    quoteText: readStringParam(params, "quoteText"),
    asVoice: typeof params.asVoice === "boolean" ? params.asVoice : undefined,
    silent: typeof params.silent === "boolean" ? params.silent : undefined,
    buttons: params.buttons,
  };
}

/**
 * Handle Discord parent ID parameter with special logic for clearing.
 *
 * @param params - Raw tool parameters
 * @returns Parent ID, null to clear, or undefined if not specified
 */
export function readParentIdParam(params: Record<string, unknown>): string | null | undefined {
  if (params.clearParent === true) {
    return null;
  }
  if (params.parentId === null) {
    return null;
  }
  return readStringParam(params, "parentId");
}
