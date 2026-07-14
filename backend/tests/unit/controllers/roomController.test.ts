import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { makeRoomController } from '../../../src/controllers/roomController';
import { ValidationError } from '../../../src/errors/AppError';
import type { Request, Response, NextFunction } from 'express';

const mockRes = () => {
  const res = { status: mock(), json: mock(), send: mock() } as any;
  res.status.mockReturnValue(res);
  return res;
};

const authedReq = (overrides: Partial<Request> = {}): any => ({
  body: {},
  params: {},
  query: {},
  user: { userId: 'user-1' },
  ...overrides,
});

describe('roomController', () => {
  const room = {
    roomId: 'room-1',
    type: 'group',
    name: 'Study Room',
    requireApproval: false,
    viewHistory: true,
    isArchived: false,
    createdAt: new Date('2026-01-01'),
  };

  const service = {
    list: mock(),
    create: mock(),
    createPrivate: mock(),
    getById: mock(),
    listMembers: mock(),
    update: mock(),
    deleteGroup: mock(),
    joinByCode: mock(),
    leave: mock(),
    approveMember: mock(),
    updateMember: mock(),
    kickMember: mock(),
    transferOwnership: mock(),
    uploadAvatar: mock(),
  };
  const ctrl = makeRoomController(service);

  beforeEach(() => mock.clearAllMocks());

  describe('list', () => {
    it('returns 200 with rooms', async () => {
      service.list.mockResolvedValue([room]);
      const res = mockRes();
      const next = mock();

      await ctrl.list(authedReq(), res, next);

      expect(service.list).toHaveBeenCalledWith('user-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith([room]);
    });

    it('calls next with error when service throws', async () => {
      service.list.mockRejectedValue(new Error('db error'));
      const res = mockRes();
      const next = mock();

      await ctrl.list(authedReq(), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('create (group)', () => {
    it('returns 201 with room on valid name', async () => {
      service.create.mockResolvedValue(room);
      const res = mockRes();
      const next = mock();

      await ctrl.create(authedReq({ body: { type: 'group', name: 'Study Room' } }), res, next);

      expect(service.create).toHaveBeenCalledWith('user-1', {
        type: 'group',
        name: 'Study Room',
        avatarUrl: undefined,
        requireApproval: undefined,
        viewHistory: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(room);
    });

    it('calls next with ValidationError when name is empty', async () => {
      const res = mockRes();
      const next = mock();

      await ctrl.create(authedReq({ body: { type: 'group', name: '   ' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next with ValidationError when name is missing', async () => {
      const res = mockRes();
      const next = mock();

      await ctrl.create(authedReq({ body: { type: 'group' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('calls next with error when service throws', async () => {
      service.create.mockRejectedValue(new Error('db error'));
      const res = mockRes();
      const next = mock();

      await ctrl.create(authedReq({ body: { type: 'group', name: 'Study Room' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('getById', () => {
    it('returns 200 with room', async () => {
      service.getById.mockResolvedValue(room);
      const res = mockRes();
      const next = mock();

      await ctrl.getById(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(service.getById).toHaveBeenCalledWith('room-1', 'user-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(room);
    });

    it('calls next with error when service throws', async () => {
      service.getById.mockRejectedValue(new Error('not found'));
      const res = mockRes();
      const next = mock();

      await ctrl.getById(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('create (private)', () => {
    it('returns 201 when a private room is newly created', async () => {
      const privateRoom = { ...room, type: 'private' as const, name: undefined };
      service.createPrivate.mockResolvedValue({ room: privateRoom, created: true });
      const res = mockRes();
      const next = mock();

      await ctrl.create(authedReq({ body: { type: 'private', targetUserId: 'user-2' } }), res, next);

      expect(service.createPrivate).toHaveBeenCalledWith('user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(privateRoom);
    });

    it('returns 200 when an existing private room is reused', async () => {
      const privateRoom = { ...room, type: 'private' as const, name: undefined };
      service.createPrivate.mockResolvedValue({ room: privateRoom, created: false });
      const res = mockRes();
      const next = mock();

      await ctrl.create(authedReq({ body: { type: 'private', targetUserId: 'user-2' } }), res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(privateRoom);
    });
  });

  describe('update', () => {
    it('returns 200 with updated room', async () => {
      const updated = { ...room, name: 'New Name' };
      service.update.mockResolvedValue(updated);
      const res = mockRes();
      const next = mock();

      await ctrl.update(authedReq({ params: { id: 'room-1' }, body: { name: 'New Name' } }), res, next);

      expect(service.update).toHaveBeenCalledWith('room-1', 'user-1', { name: 'New Name' });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(updated);
    });

    it('calls next with error when service throws', async () => {
      service.update.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = mock();

      await ctrl.update(authedReq({ params: { id: 'room-1' }, body: { name: 'X' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('join', () => {
    it('returns 200 with room', async () => {
      service.joinByCode.mockResolvedValue(room);
      const res = mockRes();
      const next = mock();

      await ctrl.join(authedReq({ body: { inviteCode: 'ABC123' } }), res, next);

      expect(service.joinByCode).toHaveBeenCalledWith('user-1', 'ABC123');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(room);
    });

    it('calls next with error when service throws', async () => {
      service.joinByCode.mockRejectedValue(new Error('invalid code'));
      const res = mockRes();
      const next = mock();

      await ctrl.join(authedReq({ body: { inviteCode: 'BAD' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('leave', () => {
    it('returns 204', async () => {
      service.leave.mockResolvedValue(undefined);
      const res = mockRes();
      const next = mock();

      await ctrl.leave(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(service.leave).toHaveBeenCalledWith('user-1', 'room-1');
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('calls next with error when service throws', async () => {
      service.leave.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = mock();

      await ctrl.leave(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('deleteGroup', () => {
    it('returns 204', async () => {
      service.deleteGroup.mockResolvedValue(undefined);
      const res = mockRes();
      const next = mock();

      await ctrl.deleteGroup(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(service.deleteGroup).toHaveBeenCalledWith('room-1', 'user-1');
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('calls next with error when service throws', async () => {
      service.deleteGroup.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = mock();

      await ctrl.deleteGroup(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('create (private type branches)', () => {
    it('returns ValidationError when private type missing targetUserId', async () => {
      const res = mockRes();
      const next = mock();

      await ctrl.create(authedReq({ body: { type: 'private' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('returns ValidationError for unknown room type', async () => {
      const res = mockRes();
      const next = mock();

      await ctrl.create(authedReq({ body: { type: 'unknown' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('creates private room and returns 201 when new', async () => {
      service.createPrivate.mockResolvedValue({ room, created: true });
      const res = mockRes();
      const next = mock();

      await ctrl.create(authedReq({ body: { type: 'private', targetUserId: 'user-2' } }), res, next);

      expect(service.createPrivate).toHaveBeenCalledWith('user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('creates private room and returns 200 when existing', async () => {
      service.createPrivate.mockResolvedValue({ room, created: false });
      const res = mockRes();
      const next = mock();

      await ctrl.create(authedReq({ body: { type: 'private', targetUserId: 'user-2' } }), res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('listMembers', () => {
    it('returns 200 with members', async () => {
      const members = [{ userId: 'user-1', role: 'owner' }];
      service.listMembers.mockResolvedValue(members);
      const res = mockRes();
      const next = mock();

      await ctrl.listMembers(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(service.listMembers).toHaveBeenCalledWith('room-1', 'user-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(members);
    });

    it('passes errors to next', async () => {
      service.listMembers.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = mock();

      await ctrl.listMembers(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('update (transferOwnership path)', () => {
    it('delegates to transferOwnership when ownerId is present in body', async () => {
      service.transferOwnership.mockResolvedValue(undefined);
      const res = mockRes();
      const next = mock();

      await ctrl.update(authedReq({ params: { id: 'room-1' }, body: { ownerId: 'user-2' } }), res, next);

      expect(service.transferOwnership).toHaveBeenCalledWith('room-1', 'user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ message: 'Ownership transferred' });
    });
  });

  describe('transferOwnership handler', () => {
    it('returns 200 on success', async () => {
      service.transferOwnership.mockResolvedValue(undefined);
      const res = mockRes();
      const next = mock();

      await ctrl.transferOwnership(authedReq({ params: { id: 'room-1' }, body: { targetUserId: 'user-2' } }), res, next);

      expect(service.transferOwnership).toHaveBeenCalledWith('room-1', 'user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('passes ValidationError to next when targetUserId is missing', async () => {
      const res = mockRes();
      const next = mock();

      await ctrl.transferOwnership(authedReq({ params: { id: 'room-1' }, body: {} }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('passes service errors to next', async () => {
      service.transferOwnership.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = mock();

      await ctrl.transferOwnership(authedReq({ params: { id: 'room-1' }, body: { targetUserId: 'user-2' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('approveMember', () => {
    it('returns 200 on success', async () => {
      service.approveMember.mockResolvedValue(undefined);
      const res = mockRes();
      const next = mock();

      await ctrl.approveMember(authedReq({ params: { id: 'room-1', userId: 'user-2' } }), res, next);

      expect(service.approveMember).toHaveBeenCalledWith('room-1', 'user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ message: 'Member approved' });
    });

    it('passes service errors to next', async () => {
      service.approveMember.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = mock();

      await ctrl.approveMember(authedReq({ params: { id: 'room-1', userId: 'user-2' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('updateMember handler', () => {
    it('delegates to approveMember and returns 200 when status is approved', async () => {
      service.approveMember.mockResolvedValue(undefined);
      const res = mockRes();
      const next = mock();

      await ctrl.updateMember(
        authedReq({ params: { id: 'room-1', userId: 'user-2' }, body: { status: 'approved' } }),
        res,
        next,
      );

      expect(service.approveMember).toHaveBeenCalledWith('room-1', 'user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ message: 'Member approved' });
    });

    it('delegates to updateMember and returns 200 when status is not approved', async () => {
      service.updateMember.mockResolvedValue(undefined);
      const res = mockRes();
      const next = mock();

      await ctrl.updateMember(
        authedReq({ params: { id: 'room-1', userId: 'user-2' }, body: { nickname: 'Bob' } }),
        res,
        next,
      );

      expect(service.updateMember).toHaveBeenCalledWith('room-1', 'user-1', 'user-2', { nickname: 'Bob' });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ message: 'Member updated' });
    });

    it('passes service errors to next', async () => {
      service.updateMember.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = mock();

      await ctrl.updateMember(
        authedReq({ params: { id: 'room-1', userId: 'user-2' }, body: {} }),
        res,
        next,
      );

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('kickMember handler', () => {
    it('returns 204 on success', async () => {
      service.kickMember.mockResolvedValue(undefined);
      const res = mockRes();
      const next = mock();

      await ctrl.kickMember(authedReq({ params: { id: 'room-1', userId: 'user-2' } }), res, next);

      expect(service.kickMember).toHaveBeenCalledWith('room-1', 'user-1', 'user-2');
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('passes service errors to next', async () => {
      service.kickMember.mockRejectedValue(new Error('forbidden'));
      const res = mockRes();
      const next = mock();

      await ctrl.kickMember(authedReq({ params: { id: 'room-1', userId: 'user-2' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('uploadAvatar handler (room)', () => {
    it('returns 200 with updated room on success', async () => {
      const updatedRoom = { ...room, avatarUrl: '/uploads/avatars/room-1.png' };
      service.uploadAvatar.mockResolvedValue(updatedRoom);
      const res = mockRes();
      const next = mock();
      const file = { originalname: 'room.png', buffer: Buffer.from([]) } as Express.Multer.File;

      await ctrl.uploadAvatar(authedReq({ params: { id: 'room-1' }, file }), res, next);

      expect(service.uploadAvatar).toHaveBeenCalledWith('room-1', 'user-1', file);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(updatedRoom);
    });

    it('passes ValidationError to next when no file is provided', async () => {
      const res = mockRes();
      const next = mock();

      await ctrl.uploadAvatar(authedReq({ params: { id: 'room-1' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(service.uploadAvatar).not.toHaveBeenCalled();
    });

    it('passes service errors to next', async () => {
      service.uploadAvatar.mockRejectedValue(new Error('storage error'));
      const res = mockRes();
      const next = mock();
      const file = { originalname: 'room.png', buffer: Buffer.from([]) } as Express.Multer.File;

      await ctrl.uploadAvatar(authedReq({ params: { id: 'room-1' }, file }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
