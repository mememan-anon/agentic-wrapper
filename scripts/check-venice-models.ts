export {};

async function main(): Promise<void> {
  const url = process.argv[2] || "https://api.venice.ai/api/v1/models";

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  console.log(`Status: ${response.status} ${response.statusText}`);

  const text = await response.text();

  try {
    const json = JSON.parse(text) as {
      data?: Array<{
        id?: string;
        model_spec?: {
          name?: string;
          description?: string;
        };
      }>;
    };

    if (Array.isArray(json.data)) {
      console.log("\nModels returned:\n");

      for (const model of json.data) {
        console.log(`- ${model.id || "unknown-id"} :: ${model.model_spec?.name || "unknown-name"}`);
      }

      console.log("\nRaw JSON follows:\n");
      console.log(JSON.stringify(json, null, 2));
      return;
    }
  } catch {
    // fall through to raw output
  }

  console.log("\nRaw response follows:\n");
  console.log(text);
}

main().catch((error) => {
  console.error("Failed to fetch Venice models");
  console.error(error);
  process.exitCode = 1;
});
