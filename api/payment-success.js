module.exports = async (req, res) => {
  const { session_id, type } = req.query;
  
  // Serve an HTML page that redirects to the extension
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Successful - AI Commenting Sidekick</title>
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
    
    .success-icon {
      width: 80px;
      height: 80px;
      margin: 0 auto 24px;
      background: #10b981;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .success-icon svg {
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
    
    .processing {
      display: none;
    }
    
    .processing.active {
      display: block;
    }
    
    .spinner {
      width: 40px;
      height: 40px;
      margin: 0 auto 16px;
      border: 3px solid #e5e7eb;
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    .info-box {
      background: #f3f4f6;
      border-radius: 8px;
      padding: 16px;
      margin-top: 24px;
      font-size: 14px;
      color: #6b7280;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="processing active" id="processing">
      <div class="spinner"></div>
      <h1>Processing Your Payment...</h1>
      <p>Please wait while we activate your subscription. This should only take a moment.</p>
    </div>
    
    <div class="success" id="success" style="display: none;">
      <div class="success-icon">
        <svg viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
        </svg>
      </div>
      <h1>Payment Successful!</h1>
      <p id="message">${type === 'topup' ? 'Your credits have been added successfully.' : 'Your Pro subscription has been activated.'}</p>
      <button class="button" onclick="window.close()">Close This Window</button>
      <div class="info-box">
        <p>You can now return to the extension and start using your ${type === 'topup' ? 'additional credits' : 'Pro features'}.</p>
        <p style="margin-top: 8px;">Session ID: ${session_id ? session_id.substring(0, 20) + '...' : 'N/A'}</p>
      </div>
    </div>
  </div>
  
  <script>
    // Wait for webhook to process
    setTimeout(() => {
      document.getElementById('processing').classList.remove('active');
      document.getElementById('processing').style.display = 'none';
      document.getElementById('success').style.display = 'block';
      
      // Try to close window after 10 seconds
      setTimeout(() => {
        try {
          window.close();
        } catch (e) {
          // Window might not close due to browser restrictions
        }
      }, 10000);
    }, 3000);
    
    // Try to notify opener window
    try {
      if (window.opener) {
        window.opener.postMessage({ 
          type: 'payment-success', 
          sessionId: '${session_id}',
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