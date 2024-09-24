import "dotenv/config";

import {
  createBot,
  createProvider,
  createFlow,
  addKeyword,
  EVENTS,
} from "@builderbot/bot";
import { MemoryDB } from "@builderbot/bot";
import { BaileysProvider } from "@builderbot/provider-baileys";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import { callbackify } from "util";

const PORT = process.env?.PORT ?? 3008;
const ASSISTANT_ID = process.env?.ASSISTANT_ID ?? "";
let isWelcomeFlowCompleted = false;
const userQueues = new Map();
const userLocks = new Map(); // New lock mechanism
const STATES = {};
const time = 4000;
let globalData;

function initialState(id) {
  if (!STATES[id]) {
    STATES[id] = {
      queue: [],
      timer: null,
      callback: null,
    };
  }
  return STATES[id];
}
function deleteState(id) {
  STATES[id] = null;
}
function restoreTimer(state) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
}
function procesingQueue(state) {
  const result = state.queue.join(" ");
  console.log({ "Mensajes-acumulados": result });
  return result;
}
export function joinMessages(ctx, callback) {
  const state = initialState(ctx.from);
  console.log({ num: ctx.from, body: ctx.body });

  restoreTimer(state);
  state.queue.push(ctx.body);
  state.callback = callback;

  state.timer = setTimeout(() => {
    const result = procesingQueue(state);
    if (state.callback) {
      state.callback(result);
      state.callback = null;
      deleteState(ctx.from);
    }
  }, time);
}

const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await typing(ctx, provider);

  if (isWelcomeFlowCompleted) {
    await delay(3000);
    const response = await toAsk(ASSISTANT_ID, ctx.body, state);
    const chunks = response.split(/\n\n+/);
    console.log(typing(ctx, provider));
    for (const chunk of chunks) {
      const cleanedChunk = chunk.trim().replace(/ [.*?] [ ] /g, "");
      await flowDynamic([{ body: cleanedChunk }]);
    }
    if (response.includes("nombre")) {
      isWelcomeFlowCompleted = false; // detienes el flujo
      await flowDynamic([
        {
          body: `Espera un momento, tomaremos tus datos, si deseas continuar escribe "si"`,
        },
      ]);
    }
  } else {
    // Si el flujo ya terminó, puedes enviar un mensaje o no responder
    await flowDynamic([
      {
        capture: false,
        body: `El asistente ha finalizado la conversación, para iniciar una nueva conversación escribe "hola tribu".`,
      },
    ]);
  }
};
const handleQueue = async (userId) => {
  const queue = userQueues.get(userId);

  // if (queue) return;
  if (userLocks.get(userId)) {
    return; // If locked, skip processing
  }

  while (queue.length > 0) {
    userLocks.set(userId, true);
    const { ctx, flowDynamic, state, provider } = queue.shift();
    try {
      await processUserMessage(ctx, { flowDynamic, state, provider });
    } catch (error) {
      console.log(`Error procesing message for user ${userId}:`, error);
    } finally {
      userLocks.set(userId, false);
    }
  }

  userLocks.delete(userId);
  userQueues.delete(userId);
};
function formatInternationalNumber(number) {
  if (number.startsWith("52") && number.length === 13) {
    const formattedNumber = "+52" + number.slice(3);
    return formattedNumber;
  }
  return number; // Retorna el número sin cambios si no cumple con el criterio específico
}

// const welcomeFlow = addKeyword(["Hola tribu"])
//   .addAnswer("Bienvenido a Tribu Living en qué puedo ayudarte?")
//   .addAction(async (ctx, { state }) => {
//     isWelcomeFlowCompleted = true;
//   });

const welcomeFlow = addKeyword(["Hola tribu"])
  .addAnswer("Bienvenido a Tribu Living en qué puedo ayudarte?")
  .addAction(
    { capture: true },
    async (
      ctx,
      { flowDynamic, endFlow, gotoFlow, fallBack, provider, state }
    ) => {
      isWelcomeFlowCompleted = true;
      joinMessages(ctx, async (mensajes) => {
        // await flowDynamic("Respuesta: " + mensajes);
        return gotoFlow(aiFlow);
      });
      return fallBack();
    }
  );

const aiFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME).addAction(
  async (ctx, { flowDynamic, state, provider }) => {
    const userId = ctx.from;

    if (!userQueues.has(userId)) {
      userQueues.set(userId, []);
    }
    const queue = userQueues.get(userId);
    queue.push({ ctx, flowDynamic, state, provider });

    if (!userLocks.get(userId) && queue.length === 1) {
      await handleQueue(userId);
    }
  }
);
const callFlow = addKeyword(["asesor", "cita"])
  .addAction((state) => {
    console.log(state);
  })
  .addAnswer(
    `Para que podamos contactarnos contigo necesito que me proporciones algunos datos. Si deseas cancelar y volver al inicio escribe "cancelar"
      \n¿Cuál es tu nombre?`,
    { capture: true },
    async (ctx, { endFlow, state }) => {
      const userContext = ctx.body.toLowerCase();
      if (userContext === "cancelar") {
        isWelcomeFlowCompleted = false;
        return endFlow(
          `Has finalizado la conversación, para iniciar una nueva escribe "hola tribu"`
        );
      }
      await state.update({ nombre: ctx.body });
    }
  )
  .addAnswer(
    "¿Cual es tu correo?",
    { capture: true },
    async (ctx, { fallBack, endFlow, state }) => {
      const userContext = ctx.body.toLowerCase();
      if (userContext === "cancelar") {
        isWelcomeFlowCompleted = false;
        return endFlow(
          `Has finalizado la conversación, para iniciar una nueva escribe "hola tribu"`
        );
      }
      if (!ctx.body.includes("@") && !ctx.body.includes(".")) {
        return fallBack("Por favor ingresa un correo");
      } else {
        isWelcomeFlowCompleted = false;
        await state.update({ correo: ctx.body });
      }
    }
  )
  .addAction(async (ctx, { state }) => {
    await state.update({ numero: formatInternationalNumber(ctx.from) });

    const body = JSON.stringify({
      properties: {
        email: state.get("correo"),
        phone: state.get("numero"),
        firstname: state.get("nombre"),
      },
    });

    const response = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts?scope=crm.objects.contacts.write&client_id=d780d669-1629-4ea0-b229-efd74311a5c4&redirect_uri=https://localhost:6392/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: process.env.HUBSPOT_TOKEN,
        },
        body,
      }
    );

    const data = await response.json();
    console.log(data.id);
    globalData = data.id;
  })
  .addAnswer("Gracias, en breve nos comunicaremos contigo");

const main = async () => {
  const adapterFlow = createFlow([welcomeFlow, aiFlow, callFlow]);
  const adapterProvider = createProvider(BaileysProvider, {
    groupsIgnore: true,
    readStatus: false,
  });
  const adapterDB = new MemoryDB();

  const { httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  });

  httpInject(adapterProvider.server);
  httpServer(+PORT);
};

main();
