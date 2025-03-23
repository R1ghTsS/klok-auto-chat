const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { ethers } = require('ethers');

const CONFIG = {
  API_BASE_URL: 'https://api1-pp.klokapp.ai/v1',
  TOKEN_FILE: 'token.txt',
  PRIVATE_KEY_FILE: 'private-key.txt',
  CHAT_INTERVAL: 60000,
  MAX_RETRIES: 5,
  RETRY_DELAY: 10000,
  RATE_LIMIT_DELAY: 86400000, // 24 hours in milliseconds
  RANDOM_MESSAGES: [
    "Hey there!",
    "What's new?",
    "How's it going?",
    "Tell me something interesting",
    "What do you think about AI?",
    "Have you heard the latest news?",
    "What's your favorite topic?",
    "Let's discuss something fun",
  ]
};

// Token management
function saveToken(token) {
  fs.writeFileSync(CONFIG.TOKEN_FILE, token);
}

function getToken() {
  try {
    return fs.readFileSync(CONFIG.TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

async function authenticate(retryCount = 0) {
  try {
    const privateKey = fs.readFileSync(CONFIG.PRIVATE_KEY_FILE, 'utf8').trim();
    const wallet = new ethers.Wallet(privateKey);
    
    const nonce = ethers.hexlify(ethers.randomBytes(32)).slice(2);
    const timestamp = new Date().toISOString();
    
    const message = `klokapp.ai wants you to sign in with your Ethereum account:\n${wallet.address}\n\n\nURI: https://klokapp.ai/\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${timestamp}`;

    console.log('Signing message:', message);
    const signedMessage = await wallet.signMessage(message);
    
    const verifyResponse = await axios.post(
      `${CONFIG.API_BASE_URL}/verify`,
      {
        signedMessage,
        message,
        referral_code: null
      },
      {
        headers: {
          'content-type': 'application/json',
          'origin': 'https://klokapp.ai',
          'referer': 'https://klokapp.ai/'
        }
      }
    );

    if (!verifyResponse.data?.session_token) {
      throw new Error('No session_token received in response');
    }

    saveToken(verifyResponse.data.session_token);
    console.log('Authentication successful!');
    return verifyResponse.data.session_token;
  } catch (error) {
    if (retryCount < CONFIG.MAX_RETRIES) {
      console.error(`Authentication failed (retry ${retryCount + 1}/${CONFIG.MAX_RETRIES}):`, error.message);
      await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
      return authenticate(retryCount + 1);
    }
    throw new Error(`Authentication failed after ${CONFIG.MAX_RETRIES} attempts: ${error.message}`);
  }
}

function createApiClient(sessionToken) {
  return axios.create({
    baseURL: CONFIG.API_BASE_URL,
    headers: {
      'x-session-token': sessionToken,
      'accept': '*/*',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'accept-language': 'en-US,en;q=0.9',
      'origin': 'https://klokapp.ai',
      'referer': 'https://klokapp.ai/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0'
    }
  });
}

async function sendDirectMessage(apiClient, message) {
  try {
    const chatData = {
      id: uuidv4(),
      title: "Auto Chat",
      messages: [{ role: "user", content: message }],
      sources: [],
      model: "gpt-4o-mini",
      created_at: new Date().toISOString(),
      language: "english"
    };

    const response = await apiClient.post('/chat', chatData);
    console.log('Message sent successfully');
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;
    
    if (status === 429 || data?.detail?.includes('rate_limit_exceeded')) {
      throw new Error('RATE_LIMIT_EXCEEDED');
    }
    
    console.error('Error sending message:', status, data || error.message);
    return null;
  }
}

async function checkPoints(apiClient) {
  try {
    const response = await apiClient.get('/points');
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    if (status === 401) {
      throw new Error('EXPIRED_TOKEN');
    }
    console.error('Error checking points:', status, error.response?.data || error.message);
    return null;
  }
}

async function handleCriticalError(error) {
  console.error(`Critical error: ${error.message}`);
  
  if (error.message === 'RATE_LIMIT_EXCEEDED') {
    console.log(`Daily limit exceeded. Restarting in 24 hours...`);
    await new Promise(resolve => setTimeout(resolve, CONFIG.RATE_LIMIT_DELAY));
  } else if (error.message === 'EXPIRED_TOKEN') {
    console.log('Token expired. Renewing authentication...');
    await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
  }
  
  return runBot();
}

async function runBot(retryCount = 0) {
  let intervalId;
  
  try {
    let sessionToken = getToken();
    let apiClient;
    
    if (!sessionToken) {
      console.log('No existing token found. Starting authentication...');
      sessionToken = await authenticate();
    }
    
    apiClient = createApiClient(sessionToken);
    console.log('Bot started successfully');

    intervalId = setInterval(async () => {
      try {
        const points = await checkPoints(apiClient);
        if (!points || points.total_points <= 0) {
          console.log('No points available. Skipping...');
          return;
        }

        const message = CONFIG.RANDOM_MESSAGES[
          Math.floor(Math.random() * CONFIG.RANDOM_MESSAGES.length)
        ];
        await sendDirectMessage(apiClient, message);

        const updatedPoints = await checkPoints(apiClient);
        console.log(`Remaining Points: ${updatedPoints.total_points}`);

      } catch (error) {
        clearInterval(intervalId);
        await handleCriticalError(error);
      }
    }, CONFIG.CHAT_INTERVAL);

  } catch (error) {
    console.error(`Startup error (retry ${retryCount + 1}/${CONFIG.MAX_RETRIES}):`, error.message);
    
    if (retryCount < CONFIG.MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
      return runBot(retryCount + 1);
    }
    console.error('Maximum retries reached. Exiting...');
    process.exit(1);
  }
}

// Start the bot with error handling
console.log('🚀 Starting Klok AI Bot...');
runBot().catch(error => {
  console.error('Bot startup failed:', error);
  process.exit(1);
});
