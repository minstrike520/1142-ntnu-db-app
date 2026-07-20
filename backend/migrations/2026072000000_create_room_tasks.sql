--- Up migration
CREATE TABLE room_tasks (
    task_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id       UUID        NOT NULL REFERENCES chat_rooms(room_id) ON DELETE CASCADE,
    title         VARCHAR(200) NOT NULL,
    description   TEXT,
    created_by    UUID        REFERENCES users(user_id) ON DELETE SET NULL,
    due_at        TIMESTAMPTZ,
    external_link VARCHAR(2048),
    status        VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX room_tasks_room_id_idx ON room_tasks (room_id);

CREATE TABLE room_task_assignees (
    task_id UUID NOT NULL REFERENCES room_tasks(task_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, user_id)
);

--- Down migration
DROP TABLE IF EXISTS room_task_assignees CASCADE;
DROP TABLE IF EXISTS room_tasks CASCADE;
