export interface EmergencyContact {
  userId: string;
  contactId: string;
  message: string;
  createdAt: Date;
  contact?: {
    name: string;
    email: string;
    avatarUrl?: string;
  };
}

export interface IEmergencyContactRepository {
  findByUserId(userId: string): Promise<EmergencyContact[]>;
  upsert(userId: string, contactId: string, message: string): Promise<{ contact: EmergencyContact, isUpdate: boolean }>;
  delete(userId: string, contactId: string): Promise<void>;
  recordAlertIfNew(userId: string, lastActivity: Date): Promise<boolean>;
  withContactLock?<T>(userId: string, contactId: string, operation: () => Promise<T>): Promise<T>;
  releaseAlertIfNew?(userId: string, lastActivity: Date): Promise<void>;
  completeAlert?(userId: string, lastActivity: Date): Promise<void>;
  /**
   * Whether this contact was already alerted for this incident. Retrying an
   * incident because a *different* contact failed must not re-alert everyone.
   */
  hasAlertDelivery?(userId: string, contactId: string, incidentId: string): Promise<boolean>;
  recordAlertDelivery?(userId: string, contactId: string, incidentId: string): Promise<void>;
}
