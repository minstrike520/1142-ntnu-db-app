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
}
