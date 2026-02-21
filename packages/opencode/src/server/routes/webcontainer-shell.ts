import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { WebContainerShell } from "@/webcontainer/shell"
import { lazy } from "@/util/lazy"
import { errors } from "../error"

export const WebContainerShellRoutes = lazy(() =>
  new Hono().post(
    "/exec/:id",
    describeRoute({
      summary: "Respond to a shell exec request (WebContainer bridge)",
      description: "Used by the host UI to return jsh output for bash tool execution.",
      operationId: "experimental.shell.exec.respond",
      responses: {
        200: {
          description: "Response accepted",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        id: z.string(),
      }),
    ),
    validator(
      "json",
      z.object({
        exitCode: z.number().int(),
        output: z.string(),
      }),
    ),
    async (c) => {
      const id = c.req.valid("param").id
      const body = c.req.valid("json")
      const ok = WebContainerShell.respond({ id, exitCode: body.exitCode, output: body.output })
      if (!ok) return c.json(false, { status: 404 })
      return c.json(true)
    },
  ),
)

