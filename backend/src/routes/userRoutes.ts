import { Router } from 'express';
import multer from 'multer';
import { ValidationError } from '../errors/AppError';
import { ALLOWED_AVATAR_MIME_TYPES, AVATAR_UPLOAD_MAX_BYTES } from '../lib/avatarUpload';
import { authMiddleware } from '../middlewares/authMiddleware';
import type { makeUserController } from '../controllers/userController';

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

export const makeUserRoutes = (ctrl: ReturnType<typeof makeUserController>): Router => {
  const router = Router();

  router.use(authMiddleware);

  router.get('/me', ctrl.getMe.bind(ctrl));
  router.post('/me/avatar', avatarUpload.single('file'), ctrl.uploadAvatar.bind(ctrl));
  router.patch('/me', ctrl.updateMe.bind(ctrl));
  router.get('/me/settings', ctrl.getMySettings.bind(ctrl));
  router.patch('/me/settings', ctrl.updateMySettings.bind(ctrl));
  router.delete('/me', ctrl.deleteMe.bind(ctrl));
  router.get('/:id', ctrl.getUserProfile.bind(ctrl));
  router.get('/', ctrl.search.bind(ctrl));
  router.get('/me/emergency-contacts', ctrl.getEmergencyContacts.bind(ctrl));
  router.post('/me/emergency-contacts', ctrl.addEmergencyContact.bind(ctrl));
  router.delete('/me/emergency-contacts/:contactId', ctrl.deleteEmergencyContact.bind(ctrl));
  router.post('/me/emergency-alert/check-inactivity', ctrl.checkEmergencyInactivity.bind(ctrl));

  return router;
};
