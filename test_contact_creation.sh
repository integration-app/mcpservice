#!/bin/bash

# Token and integration key
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY3ZWE4ZDk1YzIxOWRiNWVjNjJjOTQ3NCIsImlzcyI6ImY4OGY1MmJjLTU3YTktNDdlMy05M2IzLTg0M2ZhMGRkNTcwOCIsImV4cCI6MTc3NTEzNDg3MH0.440grQgTeHaENfkMPwAAgb-4Cyd2sdraQG3q1njy4kc"
INTEGRATION_KEY="hubspot"

# URL for SSE connection
SSE_URL="http://localhost:3000/sse?integrationKey=${INTEGRATION_KEY}&token=${TOKEN}"

# Start the curl connection in the background and save the output to a file
curl -N "${SSE_URL}" > sse_output.txt &
CURL_PID=$!

# Give it a moment to establish the connection
sleep 3

# Extract the session ID from the output file
SESSION_ID=$(grep -o '"sessionId":"[^"]*"' sse_output.txt | head -n 1 | cut -d':' -f2 | tr -d '"')

echo "Session ID: ${SESSION_ID}"

# Now send the create contact request
echo "Sending create contact request..."
RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" -d "{\"sessionId\":\"${SESSION_ID}\",\"message\":{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/execute\",\"params\":{\"name\":\"create-contact\",\"arguments\":{\"email\":\"test@example.com\",\"fullname\":\"Test User\"}}}}" http://localhost:3000/messages)

# Display the response
echo "Response: ${RESPONSE}"

# Wait a moment to see any response in the SSE stream
echo "Waiting for response in SSE stream..."
sleep 3

# Display SSE output
echo "SSE output:"
cat sse_output.txt

# Clean up
kill $CURL_PID 