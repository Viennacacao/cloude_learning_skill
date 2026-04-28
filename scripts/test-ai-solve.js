const axios = require('axios');
require('dotenv').config({ path: '../.env' });

async function testAISolve() {
  const apiKey = process.env.ZHIPU_API_KEY;
  const apiBaseUrl = process.env.ZHIPU_API_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  const model = process.env.ZHIPU_MODEL || 'glm-4-flash';

  console.log('Testing AI solve with model:', model);
  console.log('API Base URL:', apiBaseUrl);
  
  const questions = [
    {
      qid: 'test_q1',
      stem: '项目管理中，成本基准包括以下哪些内容？',
      type: 'multiple',
      options: [
        { key: 'A', text: '管理储备' },
        { key: 'B', text: '应急储备' },
        { key: 'C', text: '活动估算' },
        { key: 'D', text: '工作包估算' }
      ]
    }
  ];

  const payload = {
    model: model,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: '你是考试答题助手。只输出 JSON 数组，不要输出其他文字。字段: qid, answer, confidence, reason。single/judge answer 为单个字母，multiple answer 为字母数组。'
      },
      {
        role: 'user',
        content: JSON.stringify({ questions }, null, 2)
      }
    ]
  };

  try {
    const resp = await axios.post(apiBaseUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      }
    });

    const content = resp.data.choices[0].message.content;
    console.log('\nAI Response Content:');
    console.log(content);
    
    // Try to parse it
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      console.log('\nParsed JSON:');
      console.log(JSON.stringify(parsed, null, 2));
      console.log('\n✅ AI Test Successful!');
    } else {
      console.log('\n❌ AI Response is not a valid JSON array');
    }
  } catch (e) {
    console.error('\n❌ AI Test Failed:');
    if (e.response) {
      console.error(`Status: ${e.response.status}`);
      console.error(e.response.data);
    } else {
      console.error(e.message);
    }
  }
}

testAISolve();
