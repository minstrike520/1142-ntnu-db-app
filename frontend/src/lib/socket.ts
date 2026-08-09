import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/types';
import { getApiBaseUrl } from './api';

export type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export const createChatSocket = (token: string): ChatSocket =>
  io(getApiBaseUrl(), {
    autoConnect: false,
    auth: { token },
  });

export const sendTyping = (
  socket: ChatSocket,
  payload: Parameters<ClientToServerEvents['typing']>[0],
): void => {
  socket.emit('typing', payload);
};

export const onNewMessage = (
  socket: ChatSocket,
  handler: ServerToClientEvents['new_message'],
): (() => void) => {
  socket.on('new_message', handler);
  return () => socket.off('new_message', handler);
};

export const onMessageRecalled = (
  socket: ChatSocket,
  handler: ServerToClientEvents['message_recalled'],
): (() => void) => {
  socket.on('message_recalled', handler);
  return () => socket.off('message_recalled', handler);
};

export const onUserTyping = (
  socket: ChatSocket,
  handler: ServerToClientEvents['user_typing'],
): (() => void) => {
  socket.on('user_typing', handler);
  return () => socket.off('user_typing', handler);
};

export const onReadUpdate = (
  socket: ChatSocket,
  handler: ServerToClientEvents['read_update'],
): (() => void) => {
  socket.on('read_update', handler);
  return () => socket.off('read_update', handler);
};

export const onEmergencyAlert = (
  socket: ChatSocket,
  handler: ServerToClientEvents['emergency_alert'],
): (() => void) => {
  socket.on('emergency_alert', handler);
  return () => socket.off('emergency_alert', handler);
};

export const onSocketError = (
  socket: ChatSocket,
  handler: ServerToClientEvents['error'],
): (() => void) => {
  socket.on('error', handler);
  return () => socket.off('error', handler);
};

export const onSocketDisconnect = (
  socket: ChatSocket,
  handler: (reason: string) => void,
): (() => void) => {
  socket.on('disconnect', handler);
  return () => socket.off('disconnect', handler);
};

export const onSocketConnect = (
  socket: ChatSocket,
  handler: () => void,
): (() => void) => {
  socket.on('connect', handler);
  return () => socket.off('connect', handler);
};

export const onSocketConnectError = (
  socket: ChatSocket,
  handler: (error: Error & { data?: unknown }) => void,
): (() => void) => {
  socket.on('connect_error', handler);
  return () => socket.off('connect_error', handler);
};

export const onRealtimeReady = (
  socket: ChatSocket,
  handler: () => void,
): (() => void) => {
  socket.on('realtime_ready', handler);
  return () => socket.off('realtime_ready', handler);
};

export const onFriendRequest = (
  socket: ChatSocket,
  handler: ServerToClientEvents['friend_request'],
): (() => void) => {
  socket.on('friend_request', handler);
  return () => socket.off('friend_request', handler);
};

export const onUserStatus = (
  socket: ChatSocket,
  handler: ServerToClientEvents['user_status'],
): (() => void) => {
  socket.on('user_status', handler);
  return () => socket.off('user_status', handler);
};

export const onRoomUpdate = (
  socket: ChatSocket,
  handler: ServerToClientEvents['room_update'],
): (() => void) => {
  socket.on('room_update', handler);
  return () => socket.off('room_update', handler);
};

export const onMessageUpdated = (
  socket: ChatSocket,
  handler: ServerToClientEvents['message_updated'],
): (() => void) => {
  socket.on('message_updated', handler);
  return () => socket.off('message_updated', handler);
};
