import { describe, it, expect, beforeEach } from 'bun:test';
import { request } from '../../helpers/http';
import { honoApp as app } from '../../../src/index';
import { resetDb } from '../../helpers/resetDb';
import type { AuthResponse, FolderResponse, RoomResponse } from '../../helpers/responseTypes';

describe('Folder E2E', () => {
  let token: string;
  let userId: string;
  let roomId: string;

  beforeEach(async () => {
    await resetDb();
    
    // Create user
    const res = await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'User',
      email: 'user@example.com',
      password: 'Password123!',
    });
    token = res.body.token;
    userId = res.body.user.userId;

    // Create room
    const roomRes = await request(app)
      .post<RoomResponse>('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'group', name: 'Test Room' });
    roomId = roomRes.body.roomId;
  });

  it('should create a new folder', async () => {
    const res = await request(app)
      .post<FolderResponse>('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'My Folder' });
    expect(res.status).toBe(201);
    expect(res.body.folderId).toBeDefined();
    expect(res.body.name).toBe('My Folder');
  });

  it('should list folders', async () => {
    await request(app)
      .post<FolderResponse>('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Folder 1' });

    const res = await request(app)
      .get<FolderResponse[]>('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Folder 1');
    expect(res.body[0].roomIds).toEqual([]);
  });

  it('should delete a folder', async () => {
    const createRes = await request(app)
      .post<FolderResponse>('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Folder to Delete' });
    const folderId = createRes.body.folderId;

    const deleteRes = await request(app)
      .delete(`/api/v1/folders/${folderId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(deleteRes.status).toBe(204);

    const getRes = await request(app)
      .get<FolderResponse[]>('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.body.length).toBe(0);
  });

  it('should move rooms into a folder', async () => {
    const createRes = await request(app)
      .post<FolderResponse>('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Folder with Rooms' });
    const folderId = createRes.body.folderId;

    const moveRes = await request(app)
      .put(`/api/v1/folders/${folderId}/rooms`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roomIds: [roomId] });
    expect(moveRes.status).toBe(200);

    const getRes = await request(app)
      .get<FolderResponse[]>('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.body[0].roomIds).toContain(roomId);
  });

  it('should reject moving rooms the user does not belong to into a folder', async () => {
    const otherUser = await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'Other User',
      email: 'other@example.com',
      password: 'Password123!',
    });

    const otherRoom = await request(app)
      .post<RoomResponse>('/api/v1/rooms')
      .set('Authorization', `Bearer ${otherUser.body.token}`)
      .send({ type: 'group', name: 'Other Room' });

    const createRes = await request(app)
      .post<FolderResponse>('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Secure Folder' });

    const moveRes = await request(app)
      .put(`/api/v1/folders/${createRes.body.folderId}/rooms`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roomIds: [otherRoom.body.roomId] });

    expect(moveRes.status).toBe(403);
  });
});
