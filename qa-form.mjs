import "dotenv/config";
import { chromium } from "playwright";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const FORM_URL = process.env.FORM_URL?.trim();
const FORM_ENV = (process.env.FORM_ENV ?? "test").trim().toLowerCase();
const SUBMIT = process.argv.includes("--submit");
const HEADLESS = process.env.HEADLESS === "true";
const ALLOW_PRODUCTION_SUBMIT = process.env.ALLOW_PRODUCTION_SUBMIT === "true";
const MAX_SUBMISSIONS = Number.parseInt(process.env.MAX_SUBMISSIONS ?? "5", 10);
const DELAY_MS = Number.parseInt(process.env.DELAY_MS ?? "2500", 10);
const PRE_SUBMIT_DELAY_MS = Number.parseInt(
  process.env.PRE_SUBMIT_DELAY_MS ?? "1000",
  10
);
const RESPONSES_FILE = process.env.RESPONSES_FILE ?? "responses.json";
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? "artifacts";
const LOG_FILE = process.env.LOG_FILE ?? "qa-results.jsonl";

if (!FORM_URL) {
  throw new Error("Defina FORM_URL no arquivo .env");
}

if (!/^https:\/\/forms\.cloud\.microsoft\//i.test(FORM_URL)) {
  throw new Error("FORM_URL precisa ser uma URL do Microsoft Forms");
}

if (!Number.isInteger(MAX_SUBMISSIONS) || MAX_SUBMISSIONS < 1 || MAX_SUBMISSIONS > 5) {
  throw new Error("MAX_SUBMISSIONS deve estar entre 1 e 5");
}

if (!Number.isInteger(DELAY_MS) || DELAY_MS < 0) {
  throw new Error("DELAY_MS deve ser um número inteiro maior ou igual a zero");
}

if (
  !Number.isInteger(PRE_SUBMIT_DELAY_MS) ||
  PRE_SUBMIT_DELAY_MS < 0 ||
  PRE_SUBMIT_DELAY_MS > 10000
) {
  throw new Error("PRE_SUBMIT_DELAY_MS deve estar entre 0 e 10000");
}

if (SUBMIT && FORM_ENV === "production" && !ALLOW_PRODUCTION_SUBMIT) {
  throw new Error(
    "Para enviar neste formulário de produção, defina ALLOW_PRODUCTION_SUBMIT=true explicitamente"
  );
}

if (FORM_ENV !== "test" && FORM_ENV !== "production") {
  throw new Error("FORM_ENV deve ser test ou production");
}

const responses = JSON.parse(await readFile(RESPONSES_FILE, "utf8"));

if (!Array.isArray(responses) || responses.length !== MAX_SUBMISSIONS) {
  throw new Error(
    `${RESPONSES_FILE} deve conter exatamente ${MAX_SUBMISSIONS} respostas`
  );
}

function validateResponse(response, index) {
  if (!response || typeof response !== "object") {
    throw new Error(`Resposta ${index + 1} inválida`);
  }

  for (const field of ["variedade", "pratos", "sugestao"]) {
    if (typeof response[field] !== "string" || !response[field].trim()) {
      throw new Error(`Resposta ${index + 1}: preencha o campo ${field}`);
    }

    if (response[field].trim().toUpperCase() === "PREENCHER") {
      throw new Error(`Resposta ${index + 1}: substitua ${field} em responses.json`);
    }
  }

  if (!Number.isInteger(response.servico) || response.servico < 1 || response.servico > 6) {
    throw new Error(`Resposta ${index + 1}: servico deve estar entre 1 e 6`);
  }

  for (const field of ["satisfacaoGeral", "satisfacaoVariedade"]) {
    if (!Number.isInteger(response[field]) || response[field] < 1 || response[field] > 5) {
      throw new Error(`Resposta ${index + 1}: ${field} deve estar entre 1 e 5`);
    }
  }
}

responses.forEach(validateResponse);

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const artifactsPath = path.resolve(ARTIFACTS_DIR);
await mkdir(artifactsPath, { recursive: true });

const browser = await chromium.launch({ headless: HEADLESS });
let submitted = 0;

async function writeLog(entry) {
  await appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, "utf8");
}

async function waitForSubmissionSignal(page) {
  const networkSignal = page.waitForResponse(
    (response) => {
      const url = response.url();
      const isMicrosoftFormRequest =
        url.includes("forms.cloud.microsoft") || url.includes("forms.office.com");

      return (
        response.request().method() === "POST" &&
        isMicrosoftFormRequest &&
        !url.includes("browser.events.data.microsoft.com")
      );
    },
    { timeout: 30000 }
  );

  const uiSignal = page
    .waitForFunction(
      () => {
        const text = document.body?.innerText ?? "";
        return /Obrigado pelo seu tempo e cooperação\. Sua resposta foi registrada\.|Sua resposta foi enviada\.|Suas respostas foram enviadas com êxito\.|Enviada!|Obrigado!/i.test(
          text
        );
      },
      null,
      { timeout: 30000 }
    )
    .then(() => ({ type: "ui" }))
    .catch(() => new Promise(() => {}));

  return Promise.race([
    networkSignal.then((response) => ({ type: "network", response })),
    uiSignal
  ]);
}

try {
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    const context = await browser.newContext();
    const page = await context.newPage();
    const responseId = response.id ?? `resposta-${index + 1}`;
    const startedAt = new Date().toISOString();

    try {
      console.log(`\n[${index + 1}/${responses.length}] Abrindo formulário: ${responseId}`);
      await page.goto(FORM_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

      const startButton = page
        .getByRole("button", { name: "Iniciar agora", exact: true })
        .first();

      await startButton.waitFor({ state: "visible", timeout: 30000 });
      await startButton.click();
      console.log("  'Iniciar agora' clicado automaticamente");

      const questions = page.locator('[data-automation-id="questionItem"]');
      await questions.first().waitFor({ state: "visible", timeout: 30000 });

      const fillText = async (questionIndex, value) => {
        await questions
          .nth(questionIndex)
          .locator('[data-automation-id="textInput"]')
          .fill(value);
      };

      const fillRating = async (questionIndex, stars) => {
        await questions
          .nth(questionIndex)
          .locator(`[role="radio"][aria-label="${stars} Star"]`)
          .click();
      };

      await fillText(0, response.variedade);
      await fillText(1, response.pratos);
      await fillRating(2, response.servico);
      await fillText(3, response.sugestao);
      await fillRating(4, response.satisfacaoGeral);
      await fillRating(5, response.satisfacaoVariedade);

      await page.screenshot({
        path: path.join(artifactsPath, `${runId}-${index + 1}-filled.png`),
        fullPage: true
      });

      if (!SUBMIT) {
        await writeLog({
          responseId,
          index: index + 1,
          status: "dry-run",
          startedAt,
          finishedAt: new Date().toISOString()
        });
        console.log(`  Dry-run concluído (${responseId})`);
      } else {
        if (PRE_SUBMIT_DELAY_MS > 0) {
          console.log(`  Aguardando ${PRE_SUBMIT_DELAY_MS} ms antes de enviar...`);
          await new Promise((resolve) => setTimeout(resolve, PRE_SUBMIT_DELAY_MS));
        }

        const submitButton = page.locator('[data-automation-id="submitButton"]');
        await submitButton.waitFor({ state: "visible", timeout: 30000 });
        await submitButton.scrollIntoViewIfNeeded();

        const submissionSignalPromise = waitForSubmissionSignal(page);
        await submitButton.click();

        let submissionSignal;
        try {
          submissionSignal = await submissionSignalPromise;
        } catch (error) {
          const visibleText = await page
            .locator("body")
            .innerText()
            .catch(() => "");
          throw new Error(
            `Não foi possível confirmar o envio. A página atual contém: ${visibleText.slice(-1200)}`
          );
        }

        if (
          submissionSignal.type === "network" &&
          !submissionSignal.response.ok()
        ) {
          const responseBody = await submissionSignal.response
            .text()
            .catch(() => "");
          throw new Error(
            `O Microsoft Forms retornou HTTP ${submissionSignal.response.status()} no envio: ${responseBody.slice(0, 500)}`
          );
        }

        const submissionInfo =
          submissionSignal.type === "network"
            ? {
                signal: "network",
                httpStatus: submissionSignal.response.status()
              }
            : { signal: "ui" };
        console.log(`  Envio confirmado (${submissionInfo.signal}).`);

        // Deixa a confirmação visual aparecer antes do screenshot/log.
        await new Promise((resolve) => setTimeout(resolve, 500));

        submitted += 1;
        await page.screenshot({
          path: path.join(artifactsPath, `${runId}-${index + 1}-submitted.png`),
          fullPage: true
        });
        await writeLog({
          responseId,
          index: index + 1,
          status: "submitted",
          startedAt,
          finishedAt: new Date().toISOString(),
          ...submissionInfo
        });
        console.log(`  Enviado (${submitted}/${responses.length}): ${responseId}`);
      }
    } catch (error) {
      await page.screenshot({
        path: path.join(artifactsPath, `${runId}-${index + 1}-error.png`),
        fullPage: true
      }).catch(() => {});
      await writeLog({
        responseId,
        index: index + 1,
        status: "error",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      await context.close();
    }

    if (index < responses.length - 1 && DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }

  console.log(`\nConcluído. ${SUBMIT ? submitted : responses.length} resposta(s) processada(s).`);
  console.log(`Log: ${LOG_FILE}`);
  console.log(`Evidências: ${ARTIFACTS_DIR}`);
} finally {
  await browser.close();
}
