if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env or run via: docker compose exec backend pnpm run db:seed');
  process.exit(1);
}

async function seed() {
  const { default: pool } = await import('../db');
  console.log('Starting database seed...');

  try {
    // 1. Clean tables
    console.log('Truncating tables...');
    await pool.query(`
      TRUNCATE TABLE 
        users, 
        chat_rooms, 
        friendships, 
        blocks, 
        emergency_contacts, 
        messages, 
        room_members,
        attachments
      RESTART IDENTITY CASCADE
    `);

    // 2. Create Users
    console.log('Inserting users...');
    // ponytail: Using Bun's native password hashing for seeding
    const passwordHash = await Bun.password.hash('password123');

    const usersData = [
      { id: '11111111-1111-4111-a111-111111111111', name: 'Alice', email: 'alice@test.com' },
      { id: '22222222-2222-4222-a222-222222222222', name: 'Bob', email: 'bob@test.com' },
      { id: '33333333-3333-4333-a333-333333333333', name: 'Charlie', email: 'charlie@test.com' },
      { id: '44444444-4444-4444-a444-444444444444', name: 'Dave', email: 'dave@test.com' },
      { id: '55555555-5555-4555-a555-555555555555', name: 'Eve', email: 'eve@test.com' },
      { id: '66666666-6666-4666-a666-666666666666', name: 'Frank', email: 'frank@test.com' },
    ];

    for (const u of usersData) {
      await pool.query(
        `INSERT INTO users (user_id, name, email, password_hash, warning_enabled, warning_days, last_activity) 
         VALUES ($1, $2, $3, $4, true, 7, NOW())`,
        [u.id, u.name, u.email, passwordHash]
      );
    }

    // 3. Create Friendships
    console.log('Inserting friendships...');
    // Alice & Bob are friends
    await pool.query(
      `INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'accepted')`,
      [usersData[0].id, usersData[1].id]
    );
    // Alice & Charlie are friends
    await pool.query(
      `INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'accepted')`,
      [usersData[0].id, usersData[2].id]
    );
    // Dave requested Alice (pending)
    await pool.query(
      `INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending')`,
      [usersData[3].id, usersData[0].id]
    );

    // 4. Create Blocks
    console.log('Inserting blocks...');
    // Eve blocked Alice
    await pool.query(
      `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`,
      [usersData[4].id, usersData[0].id]
    );

    // 5. Create Group Room
    console.log('Inserting group room...');
    const groupRoomId = '77777777-7777-4777-a777-777777777777';
    await pool.query(
      `INSERT INTO chat_rooms (room_id, type, name, invite_code, require_approval, view_history) 
       VALUES ($1, 'group', 'Study Group', 'STUDY123', false, true)`,
      [groupRoomId]
    );

    // Alice is owner, Bob is admin, Charlie and Frank are members
    await pool.query(
      `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [groupRoomId, usersData[0].id]
    );
    await pool.query(
      `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [groupRoomId, usersData[1].id]
    );
    await pool.query(
      `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`,
      [groupRoomId, usersData[2].id]
    );
    await pool.query(
      `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member')`,
      [groupRoomId, usersData[5].id]
    );

    // 6. Create Messages in Group Room
    console.log('Inserting messages...');
    await pool.query(
      `INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, $3)`,
      [groupRoomId, usersData[0].id, 'Hello everyone! Welcome to the study group.']
    );
    await pool.query(
      `INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, $3)`,
      [groupRoomId, usersData[1].id, 'Hi Alice, thanks for inviting me!']
    );

    console.log('Database seed completed successfully.');
  } catch (err) {
    console.error('Error seeding database:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
