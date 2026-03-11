## CLI 

Take the excisting run-and-sync.sh script and build a great CLI:

1. Build the first fabrik run CLI around k8s/run-and-sync.sh.
2. Add --render, --dry-run, and non-interactive flags so it is verifiable without guesswork.
3. Align emitted Job/PVC metadata with the required labels and annotations from specs/051-k3s-orchestrator.md.
4. Run the new CLI against dev-single first, then dev-multi, and make that the local smoke-test path.
5. After that, use a real single-node k3s rootserver to verify production-parity behavior.

then use k3s single node on rootserver as cluster to verify it works on a acutal single node k3s
from there use terraform hetzner and wire that up.


---

now that it all works build out the rest of the feature set

-- 

from there add the remaining features

like smithers worfklow output -> grafana loki
job logs -> grafana loki

and ensure it's all properly tagged and indexible

--

and the rest of all the specs so far as they make sense. simplify where ever we can




› › add a little README.md to the complex sample highlighting how we use .fabrik-sync files, env
  variables/

make sure our example repo is self contained so anyone using the example, installing fabrik cli and pointing it at their repo will get a valid job dispatch and run provided fabrik run command goes through. the smithers workflow, docker image etc need to be properly preparred so that's the contract a user of fabrik cli gets. Define workflow, point to repo -> GO GO GO
