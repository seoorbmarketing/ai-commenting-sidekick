module.exports = async (req, res) => {
  const { type } = req.query;
  
  // Serve an HTML page for payment cancellation
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Cancelled - AI Commenting Sidekick</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f3f4f6;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      max-width: 500px;
      width: 100%;
      padding: 48px;
      text-align: center;
    }
    
    .cancel-icon {
      width: 80px;
      height: 80px;
      margin: 0 auto 24px;
      background: #ef4444;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .cancel-icon svg {
      width: 40px;
      height: 40px;
      fill: white;
    }
    
    h1 {
      color: #111827;
      font-size: 28px;
      margin-bottom: 16px;
    }
    
    p {
      color: #6b7280;
      font-size: 16px;
      line-height: 1.5;
      margin-bottom: 32px;
    }
    
    .button {
      display: inline-block;
      background: #3b82f6;
      color: white;
      padding: 12px 32px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 500;
      transition: background 0.2s;
      cursor: pointer;
      border: none;
      font-size: 16px;
    }
    
    .button:hover {
      background: #2563eb;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="cancel-icon">
      <svg viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
      </svg>
    </div>
    <h1>Payment Cancelled</h1>
    <p>Your payment was cancelled. No charges were made to your account.</p>
    <button class="button" onclick="window.close()">Close This Window</button>
  </div>
  
  <script>
    // Try to close window after 5 seconds
    setTimeout(() => {
      try {
        window.close();
      } catch (e) {
        // Window might not close due to browser restrictions
      }
    }, 5000);
    
    // Try to notify opener window
    try {
      if (window.opener) {
        window.opener.postMessage({ 
          type: 'payment-cancelled',
          purchaseType: '${type}'
        }, '*');
      }
    } catch (e) {
      console.log('Could not notify opener window');
    }
  </script>
</body>
</html>
  `;
  
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(html);
};