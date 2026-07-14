import { Router } from 'express';
import multer from 'multer';
import { ValidationError } from '../errors/AppError';
import { ALLOWED_AVATAR_MIME_TYPES, AVATAR_UPLOAD_MAX_BYTES } from '../lib/avatarUpload';
import { authMiddleware } from '../middlewares/authMiddleware';
import type { makeRoomController } from '../controllers/roomController';

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: AVATAR_UPLOAD_MAX_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_AVATAR_MIME_TYPES.includes(file.mimetype as (typeof ALLOWED_AVATAR_MIME_TYPES)[number])) {
      return cb(new ValidationError('Unsupported avatar file type'));
    }
    cb(null, true);
  },
});

export const makeRoomRoutes = (ctrl: ReturnType<typeof makeRoomController>): Router => {
  const router = Router();

  router.use(authMiddleware);

  router.get('/', ctrl.list.bind(ctrl));
  router.post('/', ctrl.create.bind(ctrl));
  router.post('/join', ctrl.join.bind(ctrl));
  router.get('/:id/members', ctrl.listMembers.bind(ctrl));
  router.post('/:id/members', ctrl.join.bind(ctrl));
  router.delete('/:id/members/me', ctrl.leave.bind(ctrl));
  router.patch('/:id/hidden', ctrl.setHidden.bind(ctrl));
  router.delete('/:id/members/:userId', ctrl.kickMember.bind(ctrl));
  router.patch('/:id/members/:userId', ctrl.updateMember.bind(ctrl));
  router.post('/:id/members/:userId/approve', ctrl.approveMember.bind(ctrl));
  router.get('/:id', ctrl.getById.bind(ctrl));
  router.patch('/:id', ctrl.update.bind(ctrl));
  router.post('/:id/avatar', avatarUpload.single('file'), ctrl.uploadAvatar.bind(ctrl));
  router.delete('/:id', ctrl.deleteGroup.bind(ctrl));

  return router;
};
