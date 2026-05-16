import { FastifyInstance } from "fastify";
import { healthRoutes } from "./health";
import { operationRoutes } from "./operations";
import { queryRoutes } from "./queries";
import { reactionRoutes } from "./reactions";

export function registerRoutes(server: FastifyInstance) {
  server.register(healthRoutes);
  server.register(operationRoutes, { prefix: "/v1" });
  server.register(queryRoutes, { prefix: "/v1" });
  server.register(reactionRoutes, { prefix: "/v1" });
}
