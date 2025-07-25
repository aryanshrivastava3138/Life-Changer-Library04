/*
# Enhance Seat Booking Status Management

1. Table Updates
  - Update seat_bookings table to support 'pending' status
  - Add constraint to handle pending bookings properly

2. Security
  - Update RLS policies to handle pending bookings
  - Ensure proper access control for booking status changes
*/

-- Update seat_bookings table to support pending status
DO $$
BEGIN
  -- Drop existing check constraint if it exists
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'seat_bookings_booking_status_check'
  ) THEN
    ALTER TABLE seat_bookings DROP CONSTRAINT seat_bookings_booking_status_check;
  END IF;

  -- Add new check constraint with pending status
  ALTER TABLE seat_bookings ADD CONSTRAINT seat_bookings_booking_status_check 
    CHECK (booking_status IN ('booked', 'available', 'pending'));
END $$;

-- Update the unique constraint to allow pending bookings
DO $$
BEGIN
  -- Drop existing unique constraint
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'seat_bookings' AND constraint_name = 'seat_bookings_shift_seat_number_booking_date_key'
  ) THEN
    ALTER TABLE seat_bookings DROP CONSTRAINT seat_bookings_shift_seat_number_booking_date_key;
  END IF;

  -- Add new unique constraint that only applies to 'booked' status
  -- This allows multiple pending requests for the same seat, but only one confirmed booking
  CREATE UNIQUE INDEX IF NOT EXISTS seat_bookings_unique_booked 
    ON seat_bookings (shift, seat_number, booking_date) 
    WHERE booking_status = 'booked';
END $$;

-- Update RLS policies to handle pending bookings
DROP POLICY IF EXISTS "Admins can update seat booking status" ON seat_bookings;
CREATE POLICY "Admins can update seat booking status"
  ON seat_bookings
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

-- Allow admins to delete rejected bookings
CREATE POLICY IF NOT EXISTS "Admins can delete seat bookings"
  ON seat_bookings
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.role = 'admin'
    )
  );