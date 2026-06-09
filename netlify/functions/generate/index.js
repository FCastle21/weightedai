const https = require("https");

exports.handler = async function(event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { prompt } = JSON.parse(event.body);

    const postData = JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      stream: true,
      messages: [{ role: "user", content: prompt }]
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(postData)
        }
      }, (res) => {
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", () => {
          try {
            const lines = body.split("\n");
            let sseOutput = "";
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                    sseOutput += `data: ${JSON.stringify({ delta: { text: parsed.delta.text } })}\n\n`;
                  }
                  if (parsed.type === "message_stop") {
                    sseOutput += "data: [DONE]\n\n";
                  }
                } catch(e) {}
              }
            }
            resolve({
              statusCode: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Access-Control-Allow-Origin": "*"
              },
              body: sseOutput
            });
          } catch(e) {
            resolve({ statusCode: 500, body: JSON.stringify({ error: e.message }) });
          }
        });
      });
      req.on("error", reject);
      req.write(postData);
      req.end();
    });

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
