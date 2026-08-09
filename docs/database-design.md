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
| `message_seq` | BIGINT | Creation order, assigned once and never changed. Orders a room's thread | NOT NULL, UNIQUE, assigned by trigger |
| `change_seq` | BIGINT | Advances on every change. Orders the global change stream | NOT NULL, UNIQUE, assigned by trigger |
| `revision` | INTEGER | 1 at creation, incremented on each change. Per-message only — not comparable across messages | NOT NULL, DEFAULT 1 |
| `client_command_id` | UUID | Sender-supplied command identifier used to make a retried send idempotent | UNIQUE (`sender_id`, `client_command_id`) WHERE NOT NULL |

#### `message_sequence_counter`
Single-row allocator behind `message_seq` and `change_seq`. Numbers are drawn by `next_message_seq()` **inside the writing transaction**, so the row lock is held until COMMIT and allocation order equals commit order. A PostgreSQL sequence cannot be used here: `nextval()` is non-transactional, so a transaction drawing a lower number may commit after one drawing a higher number, and a reader whose cursor has passed the higher number would skip the lower one permanently and silently. See [ADR-0003](adr/0003-change-sequence-from-transactional-counter.md).

| Column Name | Type | Description | Constraints |
| :--- | :--- | :--- | :--- |
| `counter_id` | BOOLEAN | Pins the table to a single row | PK, DEFAULT TRUE, CHECK (`counter_id`) |
| `current_seq` | BIGINT | Highest number allocated so far | NOT NULL, DEFAULT 0 |

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
| `last_read_id` | UUID | ID of last read message; denormalised companion to `last_read_seq` | FK(`messages`), SET NULL |
| `join_time` | TIMESTAMPTZ | Join timestamp | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
| `join_seq` | BIGINT | Join Boundary: messages at or below this `message_seq` predate the membership | NOT NULL, DEFAULT 0 |
| `last_read_seq` | BIGINT | Read Position, expressed as a `message_seq`. Only ever moves forward | NOT NULL, DEFAULT 0 |

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
