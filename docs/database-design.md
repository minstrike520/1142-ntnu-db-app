# Relational Schema Design (PostgreSQL 18)

This document defines the relational schema for the real-time group chat application.

---

### Core Entity Tables

#### `users`
| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `user_id` | UUID | Unique user identifier | PK, Default: `gen_random_uuid()` |
| `name` | VARCHAR(255) | Account username | NOT NULL |
| `email` | VARCHAR(255) | Email address | UNIQUE, NOT NULL |
| `password_hash` | VARCHAR(255) | Bcrypt hash | NOT NULL |
| `bio` | TEXT | Self biography | |
| `avatar_url` | VARCHAR(2048) | Profile image URL/path | |
| `warning_enabled`| BOOLEAN | Active emergency contact mode | NOT NULL, DEFAULT FALSE |
| `warning_days` | INT | Days of inactivity before alert; 0 to disable | NOT NULL, DEFAULT 0 |
| `last_activity` | TIMESTAMPTZ | Last active timestamp | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
| `created_at` | TIMESTAMPTZ | User registration time | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
| `deleted_at` | TIMESTAMPTZ | Soft-delete timestamp | NULLABLE |
| `lang_preference`| VARCHAR(10)| Language preference (API field: `language`) | NOT NULL, DEFAULT 'en' |
| `app_theme` | VARCHAR(10)| UI theme preference (API field: `theme`) | NOT NULL, DEFAULT 'light', CHECK (app_theme IN ('light', 'dark')) |
| `notify_desktop` | BOOLEAN | Desktop notifications preference | NOT NULL, DEFAULT TRUE |
| `notify_sound` | BOOLEAN | Sound notification preference | NOT NULL, DEFAULT TRUE |

#### `chat_rooms`
| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `room_id` | UUID | Unique chat room identifier | PK, Default: `gen_random_uuid()` |
| `type` | VARCHAR(10) | Room type (`private`, `group`) | NOT NULL, CHECK (type IN ('private', 'group')) |
| `name` | VARCHAR(255) | Group room name | |
| `avatar_url` | VARCHAR(2048) | Group room image | |
| `invite_code` | VARCHAR(255) | Unique invite join code | UNIQUE INDEX (WHERE invite_code IS NOT NULL) |
| `require_approval`| BOOLEAN | Request approval needed to join | NOT NULL, DEFAULT FALSE |
| `view_history` | BOOLEAN | New members can see history | NOT NULL, DEFAULT TRUE |
| `is_archived` | BOOLEAN | Is archived (becomes read-only) | NOT NULL, DEFAULT FALSE |
| `is_readonly` | BOOLEAN | Is read-only | NOT NULL, DEFAULT FALSE |
| `created_at` | TIMESTAMPTZ | Creation time | NOT NULL, DEFAULT CURRENT_TIMESTAMP |

#### `messages`
| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `message_id` | UUID | Unique message identifier | PK, Default: `gen_random_uuid()` |
| `room_id` | UUID | Target chat room | FK(`chat_rooms`), NOT NULL, CASCADE DELETE |
| `sender_id` | UUID | Message sender | FK(`users`), SET NULL |
| `content` | TEXT | Text content | NOT NULL |
| `reply_to_id` | UUID | Replied message ID | FK(`messages`), SET NULL |
| `is_recalled` | BOOLEAN | If message has been recalled | NOT NULL, DEFAULT FALSE |
| `sent_at` | TIMESTAMPTZ | Sent timestamp | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
| `revision` | BIGINT | Global realtime revision of the canonical snapshot | UNIQUE, NOT NULL, DEFAULT `nextval('realtime_revision_seq')` |

#### `attachments`
| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `attachment_id` | UUID | Unique attachment identifier | PK, Default: `gen_random_uuid()` |
| `message_id` | UUID | Associated message ID | FK(`messages`), CASCADE DELETE |
| `uploaded_by` | UUID | Uploader ID | FK(`users`), SET NULL |
| `file_path` | VARCHAR(255) | Storage file path | NOT NULL |
| `file_type` | VARCHAR(50) | MIME type | NOT NULL |
| `original_name` | VARCHAR(255) | Original uploaded file name | NOT NULL |
| `uploaded_at` | TIMESTAMPTZ | Uploaded timestamp | NOT NULL, DEFAULT CURRENT_TIMESTAMP |

---

### Relationship & Helper Tables

#### `room_members`
| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `room_id` | UUID | Associated room | PK, FK(`chat_rooms`), CASCADE DELETE |
| `user_id` | UUID | Member user | PK, FK(`users`), CASCADE DELETE |
| `role` | VARCHAR(10) | Member role (`owner`, `admin`, `member`, `pending`) | NOT NULL, DEFAULT 'member', CHECK (role IN ('owner', 'admin', 'member', 'pending')) |
| `nickname` | VARCHAR(255) | Nickname in this room | |
| `is_muted` | BOOLEAN | Muted status | NOT NULL, DEFAULT FALSE |
| `last_read_id` | UUID | ID of last read message | FK(`messages`), SET NULL |
| `join_time` | TIMESTAMPTZ | Join timestamp | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
| `membership_epoch` | UUID | Rotating scope token used to invalidate delta cursors after access-state changes | NOT NULL, DEFAULT `gen_random_uuid()` |

#### `friendships`
| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `requester_id` | UUID | User sending the invite | PK, FK(`users`), CASCADE DELETE |
| `addressee_id` | UUID | User receiving the invite | PK, FK(`users`), CASCADE DELETE |
| `status` | VARCHAR(20) | Friendship status (`pending`, `accepted`) | NOT NULL, CHECK (status IN ('pending', 'accepted')) |
| `created_at` | TIMESTAMPTZ | Invitation creation timestamp | NOT NULL, DEFAULT CURRENT_TIMESTAMP |

#### `blocks`
| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `blocker_id` | UUID | Blocker user ID | PK, FK(`users`), CASCADE DELETE |
| `blocked_id` | UUID | Blocked user ID | PK, FK(`users`), CASCADE DELETE |
| `created_at` | TIMESTAMPTZ | Block timestamp | NOT NULL, DEFAULT CURRENT_TIMESTAMP |

#### `folders`
| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `folder_id` | UUID | Unique folder identifier | PK, Default: `gen_random_uuid()` |
| `user_id` | UUID | Owner user ID | FK(`users`), CASCADE DELETE, NOT NULL |
| `name` | VARCHAR(50) | Folder name | NOT NULL |
| `created_at` | TIMESTAMPTZ | Folder creation timestamp | NOT NULL, DEFAULT CURRENT_TIMESTAMP |

#### `folder_rooms`
| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `folder_id` | UUID | Folder ID | PK, FK(`folders`), CASCADE DELETE |
| `room_id` | UUID | Room ID | PK, FK(`chat_rooms`), CASCADE DELETE |
| `user_id` | UUID | Owner ID for scoping uniqueness | FK(`users`), NOT NULL |
| `UNIQUE(user_id, room_id)` | | Restricts room to one folder per user | |

#### `emergency_contacts`
| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `user_id` | UUID | Account owner | PK, FK(`users`), CASCADE DELETE |
| `contact_id` | UUID | Contact user | PK, FK(`users`), CASCADE DELETE |
| `message` | TEXT | Message template to send | NOT NULL |
| `created_at` | TIMESTAMPTZ | Configuration timestamp | NOT NULL, DEFAULT CURRENT_TIMESTAMP |

#### `message_mentions`
| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `message_id` | UUID | Message ID | PK, FK(`messages`), CASCADE DELETE |
| `user_id` | UUID | Mentioned user ID | PK, FK(`users`), CASCADE DELETE |

#### `refresh_tokens`
| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `token_id` | UUID | Token identifier | PK, Default: `gen_random_uuid()` |
| `user_id` | UUID | User ID | FK(`users`), CASCADE DELETE, NOT NULL |
| `token_hash` | VARCHAR(255) | Token hash value | UNIQUE, NOT NULL |
| `expires_at` | TIMESTAMPTZ | Expiry time | NOT NULL |
| `created_at` | TIMESTAMPTZ | Creation time | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
| `revoked_at` | TIMESTAMPTZ | Revoked time | NULLABLE |
| `replaced_by` | UUID | New token ID that replaced this one | FK(`refresh_tokens`), SET NULL |

#### `emergency_alert_logs`
| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `user_id` | UUID | User ID | PK, FK(`users`), CASCADE DELETE |
| `last_activity_at`| TIMESTAMPTZ| Last activity time | PK, NOT NULL |
| `alerted_at` | TIMESTAMPTZ | Alert triggered timestamp | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
| `delivery_state` | VARCHAR(20) | Recoverable scheduler claim: `pending` or `completed` | NOT NULL, DEFAULT `pending`, CHECK |

An interrupted `pending` claim is resumed on the next inactivity-job run. It changes to `completed` only after every recipient has a durable, idempotent notification.

#### `message_changes`
Durable, immutable snapshots used by `message.delta`. A row is created for every message create, edit, or recall.

| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `revision` | BIGINT | Global ordering key | PK, DEFAULT `nextval('realtime_revision_seq')` |
| `message_id` | UUID | Changed message | FK(`messages`), CASCADE DELETE, NOT NULL |
| `room_id` | UUID | Authorization and recovery scope | FK(`chat_rooms`), CASCADE DELETE, NOT NULL |
| `change_type` | VARCHAR(10) | `created`, `updated`, or `recalled` | NOT NULL, CHECK |
| `sender_id` | UUID | Sender snapshot | FK(`users`), SET NULL |
| `content` | TEXT | Content snapshot | NOT NULL |
| `reply_to_id` | UUID | Reply target snapshot | FK(`messages`), SET NULL |
| `is_recalled` | BOOLEAN | Recall snapshot | NOT NULL |
| `sent_at` | TIMESTAMPTZ | Original message time | NOT NULL |
| `changed_at` | TIMESTAMPTZ | Change commit time | NOT NULL, DEFAULT CURRENT_TIMESTAMP |

#### `message_commands`
Stores message mutation idempotency claims. Reusing `(user_id, command_id)` with a different command type or `payload_hash` is rejected.

| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `user_id` | UUID | Command owner | PK, FK(`users`), CASCADE DELETE |
| `command_id` | VARCHAR(128) | Client-generated command ID | PK |
| `command_type` | VARCHAR(20) | `message.send`, `message.edit`, or `message.recall` | NOT NULL, CHECK |
| `payload_hash` | CHAR(64) | SHA-256 hash of message intent | NOT NULL |
| `message_id` | UUID | Canonical result | FK(`messages`), CASCADE DELETE |
| `result_revision` | BIGINT | Revision committed by the command, used to replay its original result | NULL until commit |
| `created_at` | TIMESTAMPTZ | Claim creation time | NOT NULL, DEFAULT CURRENT_TIMESTAMP |

#### `emergency_notifications`
Durable emergency-alert inbox. `pending` rows remain recoverable even if realtime publication fails.

| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `notification_id` | UUID | Notification ID | PK, DEFAULT `gen_random_uuid()` |
| `source_user_id` | UUID | Inactive source user | FK(`users`), CASCADE DELETE, NOT NULL |
| `recipient_id` | UUID | Emergency contact | FK(`users`), CASCADE DELETE, NOT NULL |
| `idempotency_key` | VARCHAR(255) | Stable inactivity/contact key | NOT NULL, UNIQUE with `recipient_id` |
| `message` | TEXT | Alert message | NOT NULL |
| `delivery_state` | VARCHAR(20) | `pending` or `published` | NOT NULL, DEFAULT `pending`, CHECK |
| `created_at` | TIMESTAMPTZ | Durable creation time | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
| `published_at` | TIMESTAMPTZ | Last successful realtime publication time | NULLABLE |
