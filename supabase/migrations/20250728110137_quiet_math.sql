/*
# Add User Approval System

1. Table Updates
  - Add approval_status to users table
  - Add approved_by and approved_at fields for tracking

2. Security
  - Update RLS policies to handle approval status
  - Ensure only admins can approve users

3. Changes
  - Remove payment dependencies
  - Add approval workflow
*/

-- Add approval status to users table
DO $$
BEGIN
  -- Add approval_status column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'approval_status'
  ) THEN
    ALTER TABLE users ADD COLUMN approval_status text DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected'));
  END IF;

  -- Add approved_by column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'approved_by'
  ) THEN
    ALTER TABLE users ADD COLUMN approved_by uuid REFERENCES users(id);
  END IF;

  -- Add approved_at column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'approved_at'
  ) THEN
    ALTER TABLE users ADD COLUMN approved_at timestamptz;
  END IF;
END $$;

-- Update existing users to be approved (for existing data)
UPDATE users SET approval_status = 'approved' WHERE approval_status IS NULL;

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_users_approval_status ON users(approval_status);

-- Update RLS policies to include approval status
DROP POLICY IF EXISTS "Admins can read all users" ON users;
CREATE POLICY "Admins can read all users"
  ON users
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can update user approval" ON users;
CREATE POLICY "Admins can update user approval"
  ON users
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.role = 'admin'
    )
  );