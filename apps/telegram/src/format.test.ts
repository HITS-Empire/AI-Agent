import { test } from "node:test";
import assert from "node:assert/strict";
import { PROJECT_NAME } from "@burmalda/shared";
import {
  approvalButtons,
  formatOwnerReply,
  isOwner,
  parseApprovalCallback,
} from "./format";

test("ответ бота начинается с названия проекта", () => {
  const text = formatOwnerReply("привет");
  assert.equal(text.startsWith(PROJECT_NAME), true);
  assert.match(text, /привет/);
});

test("бот отвечает только владельцу", () => {
  assert.equal(isOwner(42, "42"), true);
  assert.equal(isOwner(7, "42"), false);
  assert.equal(isOwner(undefined, "42"), false);
  assert.equal(isOwner(42, ""), false);
});

test("кнопки подтверждения укладываются в callback_data и разбираются обратно", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const buttons = approvalButtons(id);
  assert.ok(buttons.yes.length <= 64);
  assert.deepEqual(parseApprovalCallback(buttons.yes), {
    requestId: id,
    approved: true,
  });
  assert.deepEqual(parseApprovalCallback(buttons.no), {
    requestId: id,
    approved: false,
  });
  assert.equal(parseApprovalCallback("нет"), undefined);
});
