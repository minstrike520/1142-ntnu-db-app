import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeUserController } from '../../../src/controllers/userController';
import { ValidationError } from '../../../src/errors/AppError';

const mockRes = () => {
  const res = { status: vi.fn(), json: vi.fn(), send: vi.fn() } as any;
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

describe('userController', () => {
  const myProfile = {
    userId: 'user-1',
    name: 'Alice',
    email: 'alice@example.com',
    bio: 'Hello',
    avatarUrl: 'https://example.com/avatar.png',
  };
  const publicProfile = {
    userId: 'user-2',
    name: 'Bob',
    bio: 'Public bio',
    avatarUrl: 'https://example.com/bob.png',
  };
  const settings = {
    warningEnabled: true,
    warningDays: 3,
    language: 'zh-TW',
    theme: 'dark',
    notifyDesktop: false,
    notifySound: false,
  };
  const service = {
    getMe: vi.fn(),
    getUserProfile: vi.fn(),
    updateMe: vi.fn(),
    uploadAvatar: vi.fn(),
    getMySettings: vi.fn(),
    updateMySettings: vi.fn(),
    deleteMe: vi.fn(),
    search: vi.fn(),
    getEmergencyContacts: vi.fn(),
    upsertEmergencyContact: vi.fn(),
    deleteEmergencyContact: vi.fn(),
    checkInactivity: vi.fn(),
  } as any;
  const ctrl = makeUserController(service);

  beforeEach(() => vi.clearAllMocks());

  it('returns my profile for getMe', async () => {
    service.getMe.mockResolvedValue(myProfile);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.getMe(authedReq(), res, next);

    expect(service.getMe).toHaveBeenCalledWith('user-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(myProfile);
  });

  it('returns another user profile for getUserProfile', async () => {
    service.getUserProfile.mockResolvedValue(publicProfile);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.getUserProfile(authedReq({ params: { id: 'user-2' } }), res, next);

    expect(service.getUserProfile).toHaveBeenCalledWith('user-2');
    expect(res.json).toHaveBeenCalledWith(publicProfile);
  });

  it('updates the editable profile fields', async () => {
    const updated = { ...myProfile, name: 'Alice 2' };
    service.updateMe.mockResolvedValue(updated);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.updateMe(authedReq({ body: { name: 'Alice 2' } }), res, next);

    expect(service.updateMe).toHaveBeenCalledWith('user-1', { name: 'Alice 2' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(updated);
  });

  it('rejects empty profile payloads', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ctrl.updateMe(authedReq({ body: {} }), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it('uploads avatar for the current user', async () => {
    const updated = { ...myProfile, avatarUrl: '/uploads/avatars/user-1.png' };
    service.uploadAvatar.mockResolvedValue(updated);
    const res = mockRes();
    const next = vi.fn();
    const file = {
      fieldname: 'file',
      originalname: 'avatar.png',
      encoding: '7bit',
      mimetype: 'image/png',
      size: 16,
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    } as Express.Multer.File;

    await ctrl.uploadAvatar(authedReq({ file }), res, next);

    expect(service.uploadAvatar).toHaveBeenCalledWith('user-1', file);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(updated);
  });

  it('rejects avatar uploads without a file', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ctrl.uploadAvatar(authedReq(), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it('returns my settings', async () => {
    service.getMySettings.mockResolvedValue(settings);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.getMySettings(authedReq(), res, next);

    expect(service.getMySettings).toHaveBeenCalledWith('user-1');
    expect(res.json).toHaveBeenCalledWith(settings);
  });

  it('updates my settings', async () => {
    service.updateMySettings.mockResolvedValue(settings);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.updateMySettings(
      authedReq({
        body: {
          warningEnabled: true,
          warningDays: 3,
          language: 'zh-TW',
          theme: 'dark',
          notifyDesktop: false,
          notifySound: false,
        },
      }),
      res,
      next,
    );

    expect(service.updateMySettings).toHaveBeenCalledWith('user-1', settings);
    expect(res.json).toHaveBeenCalledWith(settings);
  });

  it('rejects invalid settings payloads', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ctrl.updateMySettings(authedReq({ body: { warningDays: -1 } }), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it('searches users', async () => {
    service.search.mockResolvedValue([{ userId: 'user-2', name: 'Bob', email: 'bob@example.com', avatarUrl: undefined }]);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.search(authedReq({ query: { q: 'bob' } }), res, next);

    expect(service.search).toHaveBeenCalledWith('bob', undefined);
    expect(res.json).toHaveBeenCalledWith([{ userId: 'user-2', name: 'Bob', email: 'bob@example.com', avatarUrl: undefined }]);
  });

  it('searches users with mode', async () => {
    service.search.mockResolvedValue([{ userId: 'user-2', name: 'Bob', email: 'bob@example.com', avatarUrl: undefined }]);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.search(authedReq({ query: { q: 'bob', mode: 'email' } }), res, next);

    expect(service.search).toHaveBeenCalledWith('bob', 'email');
    expect(res.json).toHaveBeenCalledWith([{ userId: 'user-2', name: 'Bob', email: 'bob@example.com', avatarUrl: undefined }]);
  });

  it('rejects invalid mode value', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ctrl.search(authedReq({ query: { q: 'bob', mode: 'invalid' } }), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect(service.search).not.toHaveBeenCalled();
  });

  it('soft deletes the current user', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ctrl.deleteMe(authedReq(), res, next);

    expect(service.deleteMe).toHaveBeenCalledWith('user-1');
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('returns emergency contacts', async () => {
    service.getEmergencyContacts.mockResolvedValue([{ id: 'c1' }]);
    const res = mockRes();
    const next = vi.fn();

    await ctrl.getEmergencyContacts(authedReq(), res, next);

    expect(res.json).toHaveBeenCalledWith([{ id: 'c1' }]);
  });

  it('upserts emergency contacts', async () => {
    const contact = { contactId: '550e8400-e29b-41d4-a716-446655440000', message: 'msg' };
    service.upsertEmergencyContact.mockResolvedValue({ contact, isUpdate: false });
    const res = mockRes();
    const next = vi.fn();

    await ctrl.addEmergencyContact(
      authedReq({ body: { contactId: contact.contactId, message: 'msg' } }),
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(contact);
  });

  it('deletes emergency contacts', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ctrl.deleteEmergencyContact(authedReq({ params: { contactId: 'c1' } }), res, next);

    expect(service.deleteEmergencyContact).toHaveBeenCalledWith('user-1', 'c1');
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });



  it('checks inactivity alerts', async () => {
    service.checkInactivity.mockResolvedValue({ alerted: true });
    const res = mockRes();
    const next = vi.fn();

    await ctrl.checkEmergencyInactivity(
      authedReq({ body: { now: new Date().toISOString() } }),
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ alerted: true });
  });

  it('passes through service errors', async () => {
    const err = new Error('db error');
    service.getMe.mockRejectedValue(err);
    const res = mockRes();
    const next: NextFunction = vi.fn();

    await ctrl.getMe(authedReq(), res as Response, next);

    expect(next).toHaveBeenCalledWith(err);
  });

  const errorMethods: Array<[string, any, any]> = [
    ['updateMe', (c: any) => c.updateMe, authedReq({ body: { name: 'A' } })],
    ['uploadAvatar', (c: any) => c.uploadAvatar, authedReq({ file: { originalname: 'a.png' } as any })],
    ['getUserProfile', (c: any) => c.getUserProfile, authedReq({ params: { id: 'u2' } })],
    ['getMySettings', (c: any) => c.getMySettings, authedReq()],
    ['updateMySettings', (c: any) => c.updateMySettings, authedReq({ body: { warningEnabled: true, warningDays: 1 } })],
    ['deleteMe', (c: any) => c.deleteMe, authedReq()],
    ['getEmergencyContacts', (c: any) => c.getEmergencyContacts, authedReq()],
    ['checkEmergencyInactivity', (c: any) => c.checkEmergencyInactivity, authedReq()],
    ['search', (c: any) => c.search, authedReq({ query: { q: 'alice' } })],
  ];

  for (const [name, getMethod, req] of errorMethods) {
    it(`passes service errors from ${name} to next`, async () => {
      const err = new Error(`${name} failed`);
      const key = name === 'getUserProfile' ? 'getUserProfile'
        : name === 'getMySettings' ? 'getMySettings'
        : name === 'updateMySettings' ? 'updateMySettings'
        : name === 'deleteMe' ? 'deleteMe'
        : name === 'getEmergencyContacts' ? 'getEmergencyContacts'
        : name === 'checkEmergencyInactivity' ? 'checkInactivity'
        : name === 'search' ? 'search'
        : name === 'uploadAvatar' ? 'uploadAvatar'
        : 'updateMe';
      (service as any)[key].mockRejectedValue(err);
      const res = mockRes();
      const next = vi.fn();
      await getMethod(ctrl)(req, res, next);
      expect(next).toHaveBeenCalledWith(err);
    });
  }

  it('passes service errors from addEmergencyContact to next', async () => {
    const err = new Error('upsert failed');
    service.upsertEmergencyContact.mockRejectedValue(err);
    const res = mockRes();
    const next = vi.fn();
    await ctrl.addEmergencyContact(authedReq({ body: { contactId: '550e8400-e29b-41d4-a716-446655440000', message: 'help' } }), res, next);
    expect(next).toHaveBeenCalledWith(err);
  });

  it('passes service errors from deleteEmergencyContact to next', async () => {
    const err = new Error('delete failed');
    service.deleteEmergencyContact.mockRejectedValue(err);
    const res = mockRes();
    const next = vi.fn();
    await ctrl.deleteEmergencyContact(authedReq({ params: { contactId: 'c1' } }), res, next);
    expect(next).toHaveBeenCalledWith(err);
  });



  it('passes ValidationError to next when checkEmergencyInactivity receives invalid date string', async () => {
    const res = mockRes();
    const next = vi.fn();
    await ctrl.checkEmergencyInactivity(authedReq({ body: { now: 'not-a-date' } }), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it('calls search without currentUserId when friendsOnly is not set', async () => {
    service.search.mockResolvedValue([]);
    const res = mockRes();
    const next = vi.fn();
    await ctrl.search(authedReq({ query: { q: 'alice' } }), res, next);
    expect(service.search).toHaveBeenCalledWith('alice', undefined);
  });

  it('calls search with currentUserId when friendsOnly is set', async () => {
    service.search.mockResolvedValue([]);
    const res = mockRes();
    const next = vi.fn();
    await ctrl.search(authedReq({ query: { q: 'alice', friendsOnly: 'true' } }), res, next);
    expect(service.search).toHaveBeenCalledWith('alice', undefined, 'user-1');
  });
});
