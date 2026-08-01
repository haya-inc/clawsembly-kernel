import { expect, test } from "@playwright/test";

const runtimeStub = `<!doctype html>
<html><body>
<output id="status">stub runtime</output>
<script>
const reply=(request,type,result,ok=true)=>parent.postMessage({
  type,requestId:request.requestId,ok,
  ...(ok?{result}:{error:String(result)})
},location.origin);
let credentialAttempts=0;
let runtimeStarted=false;
parent.postMessage({type:"clawsembly:byok-runtime-ready"},location.origin);
addEventListener("message",(event)=>{
  const message=event.data;
  if(message.type==="clawsembly:onboarding-runtime-start"){
    if(runtimeStarted)return;
    runtimeStarted=true;
    parent.postMessage({
      type:"clawsembly:byok-runtime-status",
      state:"running",
      label:"Fetching Edge.js and the official package image…"
    },location.origin);
    setTimeout(()=>parent.postMessage({
      type:"clawsembly:byok-runtime-status",
      state:"running",
      label:"Verifying the complete package graph…"
    },location.origin),30);
    setTimeout(()=>parent.postMessage({
      type:"clawsembly:byok-runtime-status",
      state:"running",
      label:"Starting the exact unmodified OpenClaw Gateway…"
    },location.origin),60);
    setTimeout(()=>parent.postMessage({
      type:"clawsembly:wizard-gateway-ready",
      bootMode:"cold",
      openclawVersion:"2026.7.1-2"
    },location.origin),90);
    return;
  }
  if(message.type==="clawsembly:wizard-capability-attach"){
    reply(message,"clawsembly:wizard-capability-response",{status:"attached"});
    return;
  }
  if(message.type==="clawsembly:wizard-capability-configure"){
    document.body.dataset.capabilityConfigured="true";
    reply(message,"clawsembly:wizard-capability-config-response",{
      primaryModel:"clawsembly-byok/gpt-5.6",
      providerId:"clawsembly-byok"
    });
    return;
  }
  if(message.type!=="clawsembly:wizard-rpc-request")return;
  if(message.method==="wizard.start"){
    reply(message,"clawsembly:wizard-rpc-response",{
      sessionId:"wizard-session",
      done:false,
      status:"running",
      step:{
        id:"intro",
        type:"note",
        title:"OpenClaw onboarding",
        message:"Welcome to OpenClaw"
      }
    });
    return;
  }
  if(message.method==="wizard.next"){
    const stepId=message.params.answer.stepId;
    if(stepId==="intro"){
      reply(message,"clawsembly:wizard-rpc-response",{
        done:false,
        status:"running",
        step:{
          id:"provider",
          type:"select",
          message:"Model/auth provider",
          options:[
            {value:"openai",label:"OpenAI"},
            {value:"openrouter",label:"OpenRouter"},
            {value:"__more",label:"More…"},
            {value:"skip",label:"Skip for now"}
          ]
        }
      });
      return;
    }
    if(stepId==="provider"){
      reply(message,"clawsembly:wizard-rpc-response",{
        done:false,
        status:"running",
        step:{
          id:"openai-method",
          type:"select",
          message:"OpenAI auth method",
          options:[
            {value:"openai-device-code",label:"OpenAI Device Code"},
            {value:"openai-api-key",label:"OpenAI API key"},
            {value:"__back",label:"Back"}
          ]
        }
      });
      return;
    }
    if(stepId==="openai-method"&&++credentialAttempts===1){
      reply(
        message,
        "clawsembly:wizard-rpc-response",
        "temporary Wizard transport failure",
        false
      );
      return;
    }
    reply(message,"clawsembly:wizard-rpc-response",{
      done:true,
      status:"done"
    });
    return;
  }
});
</script>
</body></html>`;

test("runs the official Wizard and adapts only its credential step", async ({
  page
}, testInfo) => {
  const apiKey = "sk-user-owned-browser-test-key";
  const sessionId = "a".repeat(64);
  const guestToken = `${sessionId}.guest_capability_for_browser_test_123456`;
  const adminToken = `${sessionId}.admin_capability_for_browser_test_123456`;
  const requests: Array<{
    apiKey?: string;
    authorization?: string;
  }> = [];

  await page.route("**/byok-runtime.html*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin"
      },
      body: runtimeStub
    });
  });
  await page.route("**/api/byok/capabilities", async (route) => {
    const request = route.request();
    requests.push(JSON.parse(request.postData() ?? "{}") as {
      apiKey?: string;
    });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        status: "ready",
        capability: {
          token: guestToken,
          adminToken,
          provider: "openai",
          providerLabel: "OpenAI",
          model: "gpt-5.6",
          modelApi: "openai-completions",
          apiPath: "/v1/chat/completions",
          openClawProvider: "clawsembly-byok",
          providerId: "clawsembly-byok",
          baseUrl: "http://127.0.0.1:4173/api/byok/v1",
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          maxRequests: 64
        }
      })
    });
  });
  await page.route("**/api/byok/capabilities/revoke", async (route) => {
    requests.push({
      authorization: route.request().headers().authorization
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        status: "revoked",
        alreadyRevoked: false
      })
    });
  });

  await page.goto("/onboard.html");
  await expect(page.getByRole("heading", {
    name: "OpenClawをブラウザで始める"
  })).toBeVisible();
  await expect(page.locator("#boot-progress")).toHaveAttribute(
    "data-state",
    "ready"
  );
  await expect(page.locator("#boot-title")).toHaveText(
    "OpenClawを起動しました"
  );
  await expect(page.locator("#boot-progress")).toHaveAttribute(
    "data-boot-mode",
    "cold"
  );
  await expect(page.getByRole("heading", {
    name: "OpenClaw onboarding"
  })).toBeVisible();
  await page.getByRole("button", { name: "続ける →" }).click();
  await expect(page.getByRole("heading", {
    name: "Model/auth provider"
  })).toBeVisible();
  await page.getByRole("button", { name: "OpenAI", exact: true }).click();

  await expect(page.locator("#credential-adapter")).toBeVisible();
  await expect(page.getByRole("heading", {
    name: "安全にモデルを接続"
  })).toBeVisible();
  await page.getByRole("button", { name: "API key OpenAI / OpenRouter" })
    .click();
  const keyInput = page.locator("#byok-key");
  await expect(keyInput).toHaveAttribute("type", "password");
  await expect(keyInput).toHaveAttribute("autocomplete", "off");
  await keyInput.fill(apiKey);
  await page.getByRole("button", { name: "APIキーを安全に接続" }).click();

  await expect(page.getByRole("button", {
    name: "接続済みのモデルで公式Wizardを再開 →"
  })).toBeVisible();
  await expect(page.locator("#wizard-error")).toContainText(
    "temporary Wizard transport failure"
  );
  await page.getByRole("button", {
    name: "接続済みのモデルで公式Wizardを再開 →"
  }).click();

  await expect(page.locator("#byok-status")).toContainText("OpenClaw 準備完了");
  await expect(page.getByRole("heading", {
    name: "OpenClawの準備が完了しました"
  })).toBeVisible();
  await expect(page.locator(".byok-runtime")).toBeVisible();
  await expect(
    page.frameLocator("#byok-runtime-frame").locator("body")
  ).toHaveAttribute("data-capability-configured", "true");
  await expect(keyInput).toHaveValue("");
  await expect(page.locator("body")).not.toContainText(apiKey);
  expect(requests[0]).toEqual({
    apiKey,
    provider: "openai",
    model: "gpt-5.6"
  });

  const browserStorage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage }
  }));
  expect(browserStorage).toEqual({ local: {}, session: {} });

  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await page.screenshot({
    path: testInfo.outputPath("official-wizard-onboarding.png"),
    fullPage: true
  });

  await page.getByRole("button", { name: "接続を破棄" }).click();
  await expect(page.locator("#byok-status")).toContainText("失効済み");
  expect(requests[1]).toEqual({
    authorization: `Bearer ${adminToken}`
  });
});

test("completes OpenAI Device Code without exposing OAuth tokens", async ({
  page
}) => {
  const sessionId = "b".repeat(64);
  const pollToken = `${sessionId}.poll_capability_for_browser_test_123456`;
  const guestToken = `${sessionId}.guest_capability_for_oauth_test_123456`;
  const adminToken = `${sessionId}.admin_capability_for_oauth_test_123456`;
  const authorizations: string[] = [];
  let polls = 0;

  await page.route("**/byok-runtime.html*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin"
      },
      body: runtimeStub
    });
  });
  await page.route("**/api/oauth/openai/device/start", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        status: "authorization_pending",
        authorization: {
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
          intervalMs: 1,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
        },
        pollToken,
        adminToken,
        pollUrl: "http://127.0.0.1:4173/api/oauth/openai/device/poll"
      })
    });
  });
  await page.route("**/api/oauth/openai/device/poll", async (route) => {
    authorizations.push(route.request().headers().authorization ?? "");
    polls += 1;
    if (polls === 1) {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          status: "authorization_pending",
          retryAfterMs: 10
        })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        status: "ready",
        capability: {
          token: guestToken,
          provider: "openai",
          providerLabel: "OpenAI ChatGPT",
          model: "gpt-5.6-sol",
          modelApi: "openai-chatgpt-responses",
          apiPath: "/v1/responses",
          openClawProvider: "openai",
          providerId: "clawsembly-byok",
          baseUrl: "http://127.0.0.1:4173/api/byok/v1",
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          maxRequests: 64
        }
      })
    });
  });
  await page.route("**/api/byok/capabilities/revoke", async (route) => {
    authorizations.push(route.request().headers().authorization ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        status: "revoked",
        alreadyRevoked: false
      })
    });
  });

  await page.goto("/onboard.html");
  await page.getByRole("button", { name: "続ける →" }).click();
  await page.getByRole("button", { name: "OpenAI", exact: true }).click();
  await page.getByRole("button", {
    name: "OpenAI Device Code ChatGPTアカウントで認証 · おすすめ"
  }).click();
  await expect(page.locator("#oauth-code")).toHaveText("ABCD-EFGH");
  await expect(page.getByRole("button", {
    name: "接続済みのモデルで公式Wizardを再開 →"
  })).toBeVisible();
  await page.getByRole("button", {
    name: "接続済みのモデルで公式Wizardを再開 →"
  }).click();

  await expect(page.locator("#byok-status")).toContainText("OpenClaw 準備完了");
  await expect(page.locator("body")).not.toContainText(guestToken);
  await expect(page.locator("body")).not.toContainText(adminToken);
  expect(authorizations.slice(0, 2)).toEqual([
    `Bearer ${pollToken}`,
    `Bearer ${pollToken}`
  ]);
  expect(await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage }
  }))).toEqual({ local: {}, session: {} });

  await page.getByRole("button", { name: "接続を破棄" }).click();
  expect(authorizations.at(-1)).toBe(`Bearer ${adminToken}`);
});

test("explains a slow first boot and offers recovery on failure", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/byok-runtime.html*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin"
      },
      body: `<!doctype html><html><body><script>
        parent.postMessage({
          type:"clawsembly:byok-runtime-ready"
        },location.origin);
      </script></body></html>`
    });
  });

  await page.goto("/onboard.html");
  await expect(page.locator("#boot-detail")).toContainText("約385 MB");
  await expect(page.locator("#boot-elapsed")).toContainText("経過");
  await expect(page.locator('[data-boot-phase="0"]')).toHaveAttribute(
    "data-boot-state",
    "active"
  );
  await page.waitForTimeout(400);
  await page.screenshot({
    path: testInfo.outputPath("slow-first-boot-mobile.png"),
    fullPage: true
  });

  await page.frameLocator("#byok-runtime-frame").locator("body").evaluate(
    () => window.parent.postMessage({
      type: "clawsembly:byok-runtime-status",
      state: "running",
      label:
        "Waiting for another Clawsembly tab to finish starting OpenClaw…"
    }, location.origin)
  );
  await expect(page.locator("#boot-title")).toHaveText(
    "別のタブの起動を待っています"
  );
  await expect(page.locator("#byok-status")).toContainText(
    "別タブの起動を待機中"
  );

  await page.frameLocator("#byok-runtime-frame").locator("body").evaluate(
    () => window.parent.postMessage({
      type: "clawsembly:byok-runtime-status",
      state: "running",
      label: "Verifying the complete package graph…"
    }, location.origin)
  );
  await expect(page.locator("#boot-title")).toHaveText(
    "OpenClawを確認しています"
  );
  await expect(page.locator("#boot-bar")).toHaveAttribute(
    "aria-valuenow",
    "38"
  );

  await page.frameLocator("#byok-runtime-frame").locator("body").evaluate(
    () => window.parent.postMessage({
      type: "clawsembly:byok-runtime-status",
      state: "fail",
      label: "FAIL"
    }, location.origin)
  );
  await expect(page.locator("#boot-progress")).toHaveAttribute(
    "data-state",
    "fail"
  );
  await expect(page.getByRole("button", {
    name: "もう一度起動する"
  })).toBeVisible();
});

test("shows when OpenClaw was restored from its boot snapshot", async ({
  page
}) => {
  await page.route("**/byok-runtime.html*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin"
      },
      body: `<!doctype html><html><body><script>
        parent.postMessage({
          type:"clawsembly:byok-runtime-ready"
        },location.origin);
        addEventListener("message",(event)=>{
          if(event.data.type!=="clawsembly:onboarding-runtime-start")return;
          parent.postMessage({
            type:"clawsembly:wizard-gateway-ready",
            bootMode:"warm",
            openclawVersion:"2026.7.1-2"
          },location.origin);
        });
      </script></body></html>`
    });
  });

  await page.goto("/onboard.html");
  await expect(page.locator("#boot-progress")).toHaveAttribute(
    "data-boot-mode",
    "warm"
  );
  await expect(page.locator("#boot-title")).toHaveText(
    "OpenClawを復元しました"
  );
  await expect(page.locator("#boot-detail")).toContainText(
    "保存済みの起動状態から復元"
  );
});

test("shows when an already-running OpenClaw Gateway was shared", async ({
  page
}) => {
  await page.route("**/byok-runtime.html*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin"
      },
      body: `<!doctype html><html><body><script>
        parent.postMessage({
          type:"clawsembly:byok-runtime-ready"
        },location.origin);
        addEventListener("message",(event)=>{
          if(event.data.type!=="clawsembly:onboarding-runtime-start")return;
          parent.postMessage({
            type:"clawsembly:wizard-gateway-ready",
            bootMode:"shared",
            ownerBootMode:"warm",
            openclawVersion:"2026.7.1-2"
          },location.origin);
        });
      </script></body></html>`
    });
  });

  await page.goto("/onboard.html");
  await expect(page.locator("#boot-progress")).toHaveAttribute(
    "data-boot-mode",
    "shared"
  );
  await expect(page.locator("#boot-title")).toHaveText(
    "実行中のOpenClawに接続しました"
  );
  await expect(page.locator("#boot-detail")).toContainText(
    "別タブの実行環境を再利用"
  );
});
