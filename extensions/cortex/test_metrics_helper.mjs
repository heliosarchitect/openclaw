import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";

const execAsync = promisify(require("child_process").exec);

async function writeMetric(type, data) {
  try {
    const pythonCmd = `python3 -c "
import sys
sys.path.append('${join(homedir(), "Projects/helios/extensions/cortex/python")}')
from metrics_writer import MetricsWriter
writer = MetricsWriter()
${generatePythonCall(type, data)}
"`;
    await execAsync(pythonCmd, { timeout: 1000 });
    console.log(`✅ Wrote ${type} metric successfully`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to write ${type} metric:`, error.message);
    return false;
  }
}

function generatePythonCall(type, data) {
  switch (type) {
    case "cortex":
      return `writer.write_cortex_metric("${data.metric_name}", ${data.metric_value}, "${data.context || ""}")`;
    case "sop":
      return `writer.write_sop_event("${data.sop_name}", ${data.tool_blocked}, "${data.tool_name || ""}", ${data.acknowledged || false})`;
    default:
      return "pass";
  }
}

async function testMetrics() {
  console.log("Testing TypeScript to Python metrics bridge...");

  // Test cortex metric
  await writeMetric("cortex", {
    metric_name: "test_integration",
    metric_value: 123.45,
    context: "typescript_test",
  });

  // Test SOP event
  await writeMetric("sop", {
    sop_name: "test_integration.ai.sop",
    tool_blocked: false,
    tool_name: "test_tool",
    acknowledged: true,
  });

  console.log("TypeScript metrics test completed");
}

testMetrics().catch(console.error);
