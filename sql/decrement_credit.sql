-- Create atomic decrement function to prevent race conditions
-- This function decrements credits atomically, preventing concurrent requests from causing incorrect deductions

CREATE OR REPLACE FUNCTION decrement_credit(
  purchase_id UUID,
  amount INTEGER DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_credits INTEGER;
  current_credits INTEGER;
BEGIN
  -- Lock the row for update to prevent concurrent modifications
  SELECT remaining_credits INTO current_credits
  FROM credit_purchases
  WHERE id = purchase_id
  FOR UPDATE;
  
  -- Check if enough credits available
  IF current_credits IS NULL OR current_credits < amount THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;
  
  -- Perform the atomic update
  UPDATE credit_purchases
  SET 
    remaining_credits = remaining_credits - amount,
    updated_at = NOW()
  WHERE id = purchase_id
  RETURNING remaining_credits INTO updated_credits;
  
  -- Return the result
  RETURN jsonb_build_object(
    'success', true,
    'remaining_credits', updated_credits,
    'amount_deducted', amount
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION decrement_credit TO authenticated;
GRANT EXECUTE ON FUNCTION decrement_credit TO service_role;