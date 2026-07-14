import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { makeAttachmentController } from '../../../src/controllers/attachmentController';
import { ValidationError } from '../../../src/errors/AppError';

describe('AttachmentController', () => {
  let mockService: any;
  let controller: any;
  let req: any;
  let res: any;
  let next: any;

  beforeEach(() => {
    mockService = {
      uploadAttachment: mock(),
      getAttachment: mock(),
    };
    controller = makeAttachmentController(mockService);
    req = { body: {}, file: null, params: {} };
    res = {
      status: mock().mockReturnThis(),
      json: mock(),
      download: mock(),
    };
    next = mock();
  });

  describe('upload', () => {
    it('passes ValidationError to next if file is missing', async () => {
      req.user = { userId: 'user-1' };
      await controller.upload(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(res.status).not.toHaveBeenCalled();
      expect(mockService.uploadAttachment).not.toHaveBeenCalled();
    });

    it('calls uploadAttachment and returns 201 on success', async () => {
      req.user = { userId: 'user-1' };
      req.file = { path: '/tmp/file.png', mimetype: 'image/png', originalname: 'test.png' } as any;
      const attachment = {
        attachmentId: 'att-1',
        uploadedBy: 'user-1',
        fileUrl: '/api/v1/attachments/att-1',
        fileType: 'image/png',
        originalName: 'test.png',
        uploadedAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      mockService.uploadAttachment.mockResolvedValue(attachment);
      
      await controller.upload(req, res, next);
      
      expect(mockService.uploadAttachment).toHaveBeenCalledWith('user-1', req.file);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(attachment);
    });
  });
});
