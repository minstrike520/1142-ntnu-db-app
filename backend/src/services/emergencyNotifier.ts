import type { MessageWithSender } from '@shared/types';
import { AppError } from '../utils/AppError';

export interface EmergencyAlertPayload {
  userId: string;
  message: string;
}

export type EmergencyDeliveryFailureCode =
  | 'CONTACT_UNAVAILABLE'
  | 'CONTACT_BLOCKED'
  | 'ROOM_UNAVAILABLE'
  | 'PERSIST_FAILED'
  | 'DELIVERY_ERROR';

/**
 * The result of trying to reach one emergency contact.
 *
 * `retryable` is what decides whether the caller gives back the dedupe marker
 * for this `lastActivity` window. A blocked or deleted contact will never
 * succeed, so retrying it every hour is pure noise; a database outage will.
 */
export type EmergencyDeliveryOutcome =
  | { delivered: true }
  | { delivered: false; retryable: boolean; code: EmergencyDeliveryFailureCode };

export interface EmergencyNotifierDeps {
  userRepo: { findById(userId: string): Promise<{ userId: string } | null> };
  socialRepo: { isBlocked(userA: string, userB: string): Promise<boolean> };
  roomService: {
    createPrivate(
      creatorId: string,
      targetUserId: string,
      bypassFriendCheck?: boolean,
    ): Promise<{ room: { roomId: string } }>;
  };
  messageService: {
    sendMessage(userId: string, roomId: string, content: string): Promise<MessageWithSender>;
  };
  emitNewMessage: (roomId: string, message: MessageWithSender) => void;
  notifyRoomJoined: (userId: string, roomId: string) => void;
}

/**
 * A 4xx `AppError` describes a rule the caller broke, so repeating the same
 * call cannot produce a different answer. Anything else — a dropped
 * connection, a constraint the code did not anticipate — may.
 */
const isPermanentFailure = (err: unknown): boolean =>
  err instanceof AppError && err.statusCode >= 400 && err.statusCode < 500;

/**
 * Delivers an emergency alert as a durable chat message, and only then as a
 * realtime signal.
 *
 * The previous implementation lived inline in `bootstrap/services.ts` and used
 * a transient `emergency_alert` socket event as the *fallback* for a failed
 * persist: precisely when no durable record existed, an offline contact was
 * sent a fire-and-forget event it could never receive, and nothing recorded
 * that the attempt had happened. There is no fallback here. Either the message
 * row exists and the contact can read it on their next sync, or the caller is
 * told the alert did not go out.
 */
export const makeEmergencyNotifier = (deps: EmergencyNotifierDeps) =>
  async (contactId: string, payload: EmergencyAlertPayload): Promise<EmergencyDeliveryOutcome> => {
    const contact = await deps.userRepo.findById(contactId);
    if (!contact) {
      return { delivered: false, retryable: false, code: 'CONTACT_UNAVAILABLE' };
    }

    // `createPrivate` below is called with `bypassFriendCheck`, which skips the
    // block check and reopens a read-only room. Without this guard an alert
    // would re-grant write access to someone who blocked the sender.
    if (await deps.socialRepo.isBlocked(payload.userId, contactId)) {
      return { delivered: false, retryable: false, code: 'CONTACT_BLOCKED' };
    }

    let roomId: string;
    try {
      const { room } = await deps.roomService.createPrivate(payload.userId, contactId, true);
      roomId = room.roomId;
    } catch (err) {
      console.error(`Emergency alert could not resolve a room for contact ${contactId}:`, err);
      return { delivered: false, retryable: !isPermanentFailure(err), code: 'ROOM_UNAVAILABLE' };
    }

    let message: MessageWithSender;
    try {
      message = await deps.messageService.sendMessage(payload.userId, roomId, payload.message);
    } catch (err) {
      console.error(`Emergency alert could not be persisted for contact ${contactId}:`, err);
      return { delivered: false, retryable: !isPermanentFailure(err), code: 'PERSIST_FAILED' };
    }

    // The durable record exists from here on, so a realtime failure must not
    // downgrade the outcome: reporting failure would hand the dedupe marker
    // back and the next run would persist a second copy of the same alert.
    try {
      deps.emitNewMessage(roomId, message);
      // The room may have just been created, in which case the contact's client
      // learns about it from `createPrivate`'s ROOM_JOINED — which fires before
      // this message exists, so the client subscribes too late to see the emit
      // above. Repeating it now makes the client refresh once more, with the
      // message already written.
      deps.notifyRoomJoined(contactId, roomId);
    } catch (err) {
      console.error(`Emergency alert persisted but realtime fan-out failed for contact ${contactId}:`, err);
    }

    return { delivered: true };
  };
