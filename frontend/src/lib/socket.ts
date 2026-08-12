import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/types';
import { getApiBaseUrl } from './api';

export type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export const createChatSocket = (token: string): ChatSocket =>
  io(getApiBaseUrl(), {
    autoConnect: false,
    auth: { token },
  });

export const joinRoom = (socket: ChatSocket, roomId: string): void => {
  socket.emit('join_room', { roomId });
};

export const leaveRoom = (socket: ChatSocket, roomId: string): void => {
  socket.emit('leave_room', { roomId });
};

export const sendMessage = (
  socket: ChatSocket,
  payload: Parameters<ClientToServerEvents['send_message']>[0],
): void => {
  socket.emit('send_message', payload);
};

export const recallMessage = (socket: ChatSocket, messageId: string): void => {
  socket.emit('recall_message', { messageId });
};

export const sendTyping = (
  socket: ChatSocket,
  payload: Parameters<ClientToServerEvents['typing']>[0],
): void => {
  socket.emit('typing', payload);
};

export const sendReadReceipt = (
  socket: ChatSocket,
  payload: Parameters<ClientToServerEvents['read_receipt']>[0],
): void => {
  socket.emit('read_receipt', payload);
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

export const onSocketError = (
  socket: ChatSocket,
  handler: ServerToClientEvents['error'],
): (() => void) => {
  socket.on('error', handler);
  return () => socket.off('error', handler);
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

export const updateMessage = (
  socket: ChatSocket,
  payload: Parameters<ClientToServerEvents['update_message']>[0],
): void => {
  socket.emit('update_message', payload);
};

export const onMessageUpdated = (
  socket: ChatSocket,
  handler: ServerToClientEvents['message_updated'],
): (() => void) => {
  socket.on('message_updated', handler);
  return () => socket.off('message_updated', handler);
};
