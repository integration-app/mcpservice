import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ZodRawShape } from "zod";
import { Action, IntegrationAppClient } from "@integration-app/sdk";
import { zodFromJsonSchema } from "./json-schema-to-zod";
import cors from "cors";

console.log('Starting server initialization...');

async function addServerTool({
  server,
  action,
  membrane,
  integrationKey,
  integrationName,
  integrationSlug
}: {
  server: McpServer;
  action: Action;
  membrane: IntegrationAppClient;
  integrationKey: string;
  integrationName: string;
  integrationSlug: string;
}) {
  // ToDo: pass JSON Schema to server directly because it's what being passed to client anyway
  const jsonSchema = {
    type: 'object',
    properties: action.inputSchema?.properties || {}
  }

  const zodShape = zodFromJsonSchema(jsonSchema) as unknown as ZodRawShape;
  
  // Use the integration's canonical name (slugified) as the prefix for the tool key
  let toolKey = `${integrationSlug}-${action.key}`;

  // Ensure the total length is under the limit (accounting for server name prefix)
  const maxToolKeyLength = 40; // Allow buffer for server name
  if (toolKey.length > maxToolKeyLength) {
    // Truncate if too long
    const truncatedKey = toolKey.substring(0, maxToolKeyLength);
    console.log(`Tool name truncated from ${toolKey} to ${truncatedKey}`);
    toolKey = truncatedKey;
  }

  server.tool(
    toolKey,
    `${integrationName}: ${action.name}`, // Add integration name to description
    zodShape,
    async (args) => {
      try {
        const result = await membrane.actionInstance({
          autoCreate: true,
          integrationKey,
          parentKey: action.key,
        })
          .run(args);

        return {
          content: [{ type: "text", text: `Output: ${result.output ? JSON.stringify(result.output) : 'No output'}` }]
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing action', { error: errorMessage, integrationKey, actionKey: action.key});
        throw new Error(`Failed to execute action: ${errorMessage}`);
      }
    }
  )
}

// Factory to create a new McpServer with tools from all integrations
async function createMcpServer({
  token
}: {
  token: string;
}) {
  console.log('Creating MCP server instance...');
  
  const membrane = new IntegrationAppClient({
    token: token
  });

  console.log('Fetching connections...');
  const connections = await membrane.connections.find();
  console.log(`Found ${connections.items.length} connections`);

  const server = new McpServer({
    name: `Integration App MCP Server`,
    version: "1.0.0",
    description: `MCP server for all Integration App connections`
  });

  console.log('Fetching actions for all connections...');
  
  for (const connection of connections.items) {
    try {
      // Log the connection to understand its structure
      console.log(`Connection structure:`, JSON.stringify(connection, null, 2));
      
      if (!connection.integration) {
        console.log(`Skipping connection ${connection.id} as it has no integration`);
        continue;
      }
      
      // The integration might be an object with an 'id' property or a string
      let integrationId;
      if (typeof connection.integration === 'string') {
        integrationId = connection.integration;
      } else if (typeof connection.integration === 'object' && connection.integration !== null) {
        // If it's an object, try to get the id or key property
        integrationId = connection.integration.id || connection.integration.key;
      }
      
      if (!integrationId) {
        console.log(`Skipping connection ${connection.id} as could not determine integration ID`);
        continue;
      }
      
      console.log(`Processing connection: ${connection.name} (${connection.id}) with integration ID: ${integrationId}`);
      
      // Get the integration details
      const integration = await membrane.integration(integrationId).get();
      console.log(`Found integration: ${integration.name} (${integration.id})`);
      
      // Slugify the integration name for use in tool keys
      const integrationSlug = integration.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      
      // ToDo: iterate over pages of actions
      const actions = await membrane.actions.find({
        integrationId: integration.id,
      });
      console.log(`Found ${actions.items.length} actions for ${integration.name}`);

      for (const action of actions.items) {
        await addServerTool({
          server,
          action,
          membrane,
          integrationKey: integration.key,
          integrationName: integration.name, // Use canonical integration name for description
          integrationSlug // Use canonical integration name for tool key
        });
      }
    } catch (error) {
      console.error(`Error processing connection ${connection.id}:`, error);
      // Continue with next connection
    }
  }

  console.log('MCP server instance created successfully');
  return server;
}

console.log('Setting up Express app...');
const app = express();
app.use(express.json());
app.use(cors()); // Enable CORS for all routes

// Store transports for each session type
const transports = {
  streamable: {} as Record<string, StreamableHTTPServerTransport>,
  sse: {} as Record<string, SSEServerTransport>
};

// Modern Streamable HTTP endpoint
app.all('/mcp', async (req, res) => {
  console.log('Received request to /mcp endpoint');
  // Handle Streamable HTTP transport for modern clients
  // Implementation as shown in the "With Session Management" example
  // ...
});

// Legacy SSE endpoint for older clients
app.get('/sse', async (req, res) => {
    console.log('Received SSE connection request');
    const token = req.query.token as string;

    if (!token) {
        console.log('SSE request missing token');
        res.status(400).json({ error: 'Token is required' });
        return;
    }

    console.log(`Setting up SSE transport for token`);
    // Create SSE transport for legacy clients
    const transport = new SSEServerTransport('/messages', res);
    transports.sse[transport.sessionId] = transport;

    res.on("close", () => {
        console.log(`SSE connection closed for session: ${transport.sessionId}`);
        delete transports.sse[transport.sessionId];
    });

    try {
      console.log('Creating new server instance for SSE connection');
      // Create a new server instance per connection
      const server = await createMcpServer({
        token
      });
      console.log('Connecting to transport...');
      await server.connect(transport);
      console.log('Connected to transport successfully');
    } catch (error) {
      console.error('Error in SSE endpoint:', error);
      res.status(500).end();
    }
});

// Legacy message endpoint for older clients
app.post('/messages', async (req, res) => {
  console.log('Received message post request');
  const sessionId = req.query.sessionId as string;
  const transport = transports.sse[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    console.log(`No transport found for sessionId: ${sessionId}`);
    res.status(400).send('No transport found for sessionId');
  }
});

// Add a basic health check endpoint
app.get('/', (req, res) => {
  console.log('Health check endpoint called');
  res.status(200).send('MCP Server is running. Use /sse endpoint for SSE connections.');
});

// Use Heroku's dynamic port assignment or default to 3000
const PORT = process.env.PORT || 3000;
console.log(`Attempting to start server on port ${PORT}...`);
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});