/**
 * Cloudflare Workers entry point for React Router v7
 */

import { createRequestHandler } from "react-router";

// Import the server build
// @ts-expect-error - This will be bundled by wrangler
import * as serverBuild from "../build/server/index.js";

// The load context this worker builds below. React Router leaves
// AppLoadContext empty, so without this augmentation routes see
// context.cloudflare as unknown. @react-router/cloudflare declared the same
// shape, but nothing imported it so the augmentation never loaded.
declare module "react-router" {
  interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
      caches: CacheStorage;
    };
  }
}

const requestHandler = createRequestHandler(serverBuild, "production");

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      return await requestHandler(request, {
        cloudflare: {
          env,
          ctx,
          caches,
        },
      });
    } catch (error) {
      console.error("Request handler error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
