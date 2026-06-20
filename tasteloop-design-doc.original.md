# TasteLoop / Design Agent Design Doc

## Summary

TasteLoop is an npm CLI demo harness for evolving frontend design teams.

Given a design goal, brand book, and constraints, TasteLoop spawns multiple candidate design teams, runs them against the same task, scores their outputs, fires weak teams, keeps strong teams, merges strong teams into children, and repeats for several generations.

The self-improving version adds Cognee-backed memory:

- **Team improvement:** winning team patterns are remembered and used to spawn better future teams.
- **Member upskilling:** a weak or promising team member can improve its own role instructions from critique, traces, and scores.

The hackathon claim:

> Evolutionary design teams produce stronger frontend designs than a single static design agent, and Cognee-backed team/member self-improvement makes later generations better at using prior critique.

This is inspired by the `agent_evo` architecture, but it is not a Python port. TasteLoop should be a TypeScript-first npm package for practical frontend design generation.

## Package Boundary

Working product name: **TasteLoop**.

Suggested npm package:

```text
@taste-loop/design-agent
```

Suggested CLI binary:

```text
tasteloop
```

The package should expose both:

- a CLI for practical developer use
- a programmatic API for embedding the evolutionary design loop in other tools

This keeps the project productized as an npm package while allowing the internal architecture to be a multi-agent evolutionary system.

## Primary UX

The user gives TasteLoop a design goal and brand book. TasteLoop runs an evolutionary design competition and writes the winning design.

```bash
npx tasteloop evolve \
  --goal ./goal.md \
  --brand ./brand-book.md \
  --out ./generated-site \
  --generations 3 \
  --population 4 \
  --framework next-tailwind
```

The command produces:

- candidate design team definitions
- generated frontend file trees
- design rationales
- scores and judge reasoning
- generation-by-generation trace
- fired/kept/merged team decisions
- optional member upskilling records
- final selected design

Programmatic API:

```ts
import { generateDesign } from "@taste-loop/design-agent";

const result = await generateDesign({
  goal,
  brandBook,
  framework: "next-tailwind",
  populationSize: 4,
  generations: 3,
  outputDir: "./generated-site",
});
```

## Product Shape

TasteLoop is not just a single frontend agent. It is an **evolutionary design studio**.

```text
User goal + brand book
  -> spawn candidate design teams
  -> run every team
  -> judge every output
  -> fire weak teams
  -> keep strong teams
  -> merge strong teams into child teams
  -> optionally upskill team members
  -> repeat
  -> write winning design
```

The user should experience one autonomous system. Internally, that system is running many design teams.

## What Transfers From `agent_evo`

Useful architecture to adapt:

- **Builder:** generate candidate teams/pipelines for the task.
- **Runner:** execute a team against the task and collect artifacts.
- **Judge:** score outputs with an explicit rubric.
- **Selector:** keep the highest-scoring teams.
- **Merger:** combine strong teams into improved children.
- **Orchestrator:** manage generations, budgets, and stopping conditions.
- **Virtual file system:** store generated files in memory before writing.
- **Trace store:** record prompts, outputs, scores, team decisions, and run metadata.

Things to avoid:

- no MongoDB requirement in v1
- no generated artifacts mixed into source
- no unsafe shell tools by default
- no Python-specific runtime assumptions
- no opaque evaluator prompts
- no hard dependency on one model provider

### Direct Concept Mapping

| `agent_evo` concept | TasteLoop equivalent | Notes |
| --- | --- | --- |
| `Agent` | `DesignMember` | A specialist role with instructions, model settings, and allowed capabilities. |
| `Team` | `DesignTeam` | Directed graph of members with an entry point and handoff edges. |
| `TeamRunner` | `DesignRunner` | Executes a candidate design pipeline and returns files + trace. |
| `OneShotBuilder` | `DesignTeamBuilder` | Produces candidate teams from goal, brand, constraints, and memory. |
| `OneShotJudge` | `DesignJudge` | Scores artifacts with an explicit rubric and reasoning. |
| `OneShotMerger` | `DesignMerger` | Combines parent teams into a child team. |
| `orchestration.py` | `EvolutionOrchestrator` | Manages generations, scoring, selection, merging, and final output. |
| `FileSystem` | `VirtualFileSystem` | Keeps generated files in memory until a winner is selected. |
| generated `generations/**` | local `TraceStore` | Run artifacts are outputs, not source files. |

The big idea to preserve is **evolution over agent teams**, not the exact execution mechanics.

## MVP Definition

The MVP should be small but real.

### In Scope

- one CLI command: `tasteloop evolve`
- one programmatic API: `generateDesign()`
- local markdown inputs for goal and brand book
- fixed framework target: `next-tailwind` or `react-tailwind`
- population size 2-4
- generations 1-3
- local JSON trace store
- in-memory virtual file system
- mockable model provider
- explicit design scoring rubric
- deterministic score aggregation and selection
- example goal and brand book
- tests for non-LLM logic

### Out Of Scope For MVP

- hosted service
- visual browser screenshot judging
- real deployment
- design system generator
- broad plugin ecosystem
- automatic public web research
- complex tool execution
- hard dependency on Cognee for basic runs

Cognee-backed improvement can be an optional extension in v1, but the architecture should make it first-class.

## Core Architecture

### `DesignTeamBuilder`

Generates candidate teams for a design task.

Inputs:

- design goal
- brand book
- constraints
- prior winning patterns, if memory is enabled

Outputs:

- team name
- team strategy
- member roles
- member prompts/instructions
- pipeline/handoff order

Example teams:

- conversion-led landing page team
- editorial premium brand team
- accessibility-first product team
- motion-rich launch page team

Builder should support two modes:

- **fresh population:** create diverse teams from scratch.
- **memory-seeded population:** create teams using prior winning patterns and known failure modes.

### `DesignRunner`

Runs one candidate team and produces a design artifact.

Outputs:

- virtual file tree
- design rationale
- team trace
- member outputs
- implementation notes

For MVP, this can be a structured LLM call that emits files as JSON. Later it can become a true multi-agent execution loop.

Runner should not write to disk directly. It writes to `VirtualFileSystem`, then returns a `DesignRunResult`.

### `DesignJudge`

Scores one candidate output against the locked rubric.

Rubric:

- brand fidelity
- visual hierarchy
- layout quality
- responsiveness
- accessibility
- frontend code quality
- content fit
- originality within brand constraints
- production readiness

The judge returns:

- numeric score
- per-category scores
- reasoning
- failure modes
- improvement suggestions

Judge prompts must be checked into source and visible. The package should make it easy to inspect or override them.

### `DesignSelector`

Ranks candidate teams and decides:

- winners to keep
- weak teams to fire
- parent teams to merge
- members worth upskilling

Selection must be deterministic given scores and tie-breakers.

V1 selection rule:

```text
Sort by total score descending.
Break ties by production readiness, then accessibility, then shorter trace.
Keep top 50%, minimum 1.
Fire the rest.
Use top 2 as parents when merging is enabled.
```

### `DesignMerger`

Combines strong parent teams into an improved child team.

It should merge:

- role composition
- design strategy
- useful constraints
- judge feedback
- winning patterns

It should reject:

- redundant roles
- conflicting brand interpretations
- overfit tactics from one task

### `MemberUpskiller`

Improves an individual team member from evidence.

Example:

```text
Visual Designer v1:
- overused gradients
- missed brand typography constraint
- weak mobile spacing

Upskilled Visual Designer v2:
- explicitly checks brand typography before layout
- uses restrained palette rules
- adds mobile spacing checklist
```

This is where the "team member self-improves" idea lives.

### `EvolutionOrchestrator`

Runs the full loop:

```text
1. Build initial population.
2. Run every team.
3. Judge every output.
4. Store traces and scores.
5. Select winners.
6. Fire weak teams.
7. Merge winners into children.
8. Optionally upskill selected members.
9. Repeat until generation budget is exhausted.
10. Write final winning design.
```

Important: the orchestrator owns fairness. If running a hackathon A/B comparison, it must enforce equal population, generation, model, and judge budgets.

### `VirtualFileSystem`

Stores generated files in memory:

```ts
vfs.write("app/page.tsx", content);
vfs.write("app/globals.css", content);
vfs.write("README.md", rationale);
```

Benefits:

- compare candidates before writing to disk
- avoid partial file writes
- make tests simple
- support trace snapshots

### `TraceStore`

Stores local JSON artifacts:

```text
runs/<run-id>/
  input.json
  generations/gen-0/teams/team-a.json
  generations/gen-0/teams/team-a-output.json
  generations/gen-0/teams/team-a-score.json
  generations/gen-1/merge-decision.json
  final-result.json
```

Traces should make every decision inspectable.

Trace data is part of the product. The user should be able to answer:

- Which teams were spawned?
- Why did each team score well or poorly?
- Which teams were fired?
- Which teams were merged?
- Which member was upskilled?
- What evidence caused the upskill?
- Which final files came from the winning team?

## TypeScript Data Model

The npm package should use simple serializable types inspired by `agent_evo`.

### `DesignMember`

```ts
export interface DesignMember {
  id: string;
  name: string;
  role:
    | "brand-interpreter"
    | "information-architect"
    | "visual-designer"
    | "frontend-implementer"
    | "accessibility-reviewer"
    | "conversion-reviewer"
    | "design-judge"
    | string;
  instructions: string;
  model?: string;
  temperature?: number;
  version?: number;
  learnedFrom?: string[];
}
```

### `DesignTeam`

```ts
export interface DesignTeam {
  id: string;
  name: string;
  strategy: string;
  memberIds: string[];
  edges: Array<{
    from: string;
    to: string;
    purpose: string;
  }>;
  entryPoint: string;
}
```

Validation rules:

- `entryPoint` must exist in `memberIds`.
- every edge endpoint must exist in `memberIds`.
- teams should avoid cycles in MVP.

### `DesignRunResult`

```ts
export interface DesignRunResult {
  teamId: string;
  files: Record<string, string>;
  rationale: string;
  memberOutputs: Record<string, string>;
  executionTrace: Array<{
    step: number;
    memberId: string;
    task: string;
    outputSummary: string;
  }>;
}
```

### `DesignScore`

```ts
export interface DesignScore {
  total: number;
  categories: {
    brandFidelity: number;
    visualHierarchy: number;
    layoutQuality: number;
    responsiveness: number;
    accessibility: number;
    codeQuality: number;
    contentFit: number;
    originality: number;
    productionReadiness: number;
  };
  reasoning: string;
  failureModes: string[];
  improvementSuggestions: string[];
}
```

### `EvolutionResult`

```ts
export interface EvolutionResult {
  runId: string;
  winningTeam: DesignTeam;
  winningFiles: Record<string, string>;
  generations: Array<{
    index: number;
    candidates: Array<{
      team: DesignTeam;
      score: DesignScore;
      fired: boolean;
    }>;
    mergeDecisions: string[];
    upskillDecisions: string[];
  }>;
  traceDir?: string;
}
```

## Cognee Self-Improvement

Cognee is most useful after the basic evolutionary loop exists.

### Level 1: Team Memory

Remember what kinds of teams win for certain task/brand patterns.

Example durable lesson:

```text
For premium AI consultancy homepages, teams that combine brand interpretation,
editorial information architecture, and restrained visual design outperform
conversion-only teams.
```

Use it next time to seed better initial teams.

Implementation idea:

```text
remember(team strategy + score + judge reasoning + brand/task tags)
improve(dataset, session_ids=[run_session])
recall("What team patterns win for premium AI consultancy homepages?")
```

### Level 2: Member Upskilling

Remember how specific roles fail and improve their instructions.

Example:

```text
The Visual Designer role repeatedly violates brand typography constraints when
the brand book includes strict type rules. Add an explicit typography compliance
check before layout generation.
```

Use it to spawn `Visual Designer v2`.

Member upskilling should be evidence-bound:

```text
member trace -> repeated failure -> proposed instruction patch -> child member v2
```

Do not mutate a member just because one judge disliked one output. Require either a severe failure or repeated evidence.

### Level 3: Team Mutation

Use run traces and judge feedback to propose child teams:

```text
Parent A had strong brand fidelity.
Parent B had strong conversion hierarchy.
Child team keeps A's Brand Interpreter and B's Information Architect.
```

Cognee can store and retrieve the evidence behind those choices.

For the hackathon, show this visually:

```text
Fired: Conversion Sprint Team (score 61)
Kept: Editorial Premium Team (score 84)
Kept: Accessibility Product Team (score 79)
Merged child: Premium Product Story Team
Upskilled member: Visual Designer v2
Reason: prior output violated typography and spacing constraints
```

## Fair Hackathon Comparison

Show two side-by-side runs with the same goal, brand book, model, budget, and evaluator.

| Variable | Baseline Evolution | Self-Improving Evolution |
| --- | --- | --- |
| goal | same | same |
| brand book | same | same |
| framework | same | same |
| population | same | same |
| generations | same | same |
| evaluator | same | same |
| trace store | same | same |
| team evolution | yes | yes |
| Cognee team memory | no | yes |
| member upskilling | no | yes |

This proves two things:

1. Evolutionary teams are useful because multiple candidates compete.
2. Cognee-backed self-improvement is useful because later teams/members are seeded by prior evidence.

## Demo Script

1. Show the design goal and brand book.
2. Start two runs side by side:
   - baseline evolution
   - self-improving evolution
3. Generation 0:
   - both spawn several design teams
   - each team creates a candidate design
   - judge scores every output
4. Selection:
   - weak teams are fired
   - strong teams are kept
5. Generation 1:
   - baseline merges winners without memory
   - self-improving run retrieves Cognee lessons and upskills one member
6. Final:
   - both produce a winning frontend file tree
   - report shows scores, traces, fired teams, merged teams, and upskilled member
7. Explain the difference:
   - baseline evolved through selection only
   - self-improving evolved through selection plus remembered evidence

The demo should not rely on hiding the baseline. The point is to make the evolutionary process visible.

## What Would Make The Demo Unfair

- self-improving run gets more generations
- self-improving run gets a larger population
- self-improving run gets a stronger model
- evaluator sees which run is self-improving
- human manually edits only the self-improving output
- baseline is intentionally given weaker team prompts
- self-improvement uses hand-written lessons not derived from traces

## Base Design Team Members

Candidate teams can choose from these role archetypes.

### `Brand Interpreter`

Converts the brand book into design tokens, tone rules, and visual constraints.

### `Information Architect`

Decides page sections, content hierarchy, navigation, and user journey.

### `Visual Designer`

Creates layout direction, typography scale, spacing system, and visual language.

### `Frontend Implementer`

Turns the design plan into React/Next/Tailwind files.

### `Accessibility Reviewer`

Checks semantics, contrast, keyboard ergonomics, and responsive risks.

### `Conversion Reviewer`

Checks clarity, CTA hierarchy, audience fit, and persuasion quality.

### `Design Judge`

Scores final artifacts against the rubric.

## Inputs

### Goal

Markdown or string:

```text
Create a homepage for a premium AI automation consultancy.
The site should feel sharp, trustworthy, and technically sophisticated.
```

### Brand Book

Markdown or JSON:

```text
Colors: black, ivory, electric blue accent.
Typography: editorial serif headlines, precise sans body.
Tone: confident, calm, non-hypey.
Audience: founders and operations leaders.
Do: use strong hierarchy and proof points.
Do not: use generic AI gradients, cartoon robots, or vague productivity copy.
```

### Constraints

Optional:

- target framework
- page sections
- assets
- responsive requirements
- accessibility requirements
- design system

## Outputs

The final result should include:

- generated file tree
- final selected team
- final selected design
- design rationale
- scores
- iteration trace
- fired teams
- merged teams
- upskilled members
- known limitations

## Scoring Rubric

| Category | Weight |
| --- | ---: |
| Brand fidelity | 20 |
| Visual hierarchy | 15 |
| Layout quality | 15 |
| Responsiveness | 10 |
| Accessibility | 10 |
| Frontend code quality | 10 |
| Content fit | 10 |
| Originality within constraints | 5 |
| Production readiness | 5 |

## MVP File Structure

```text
design-agent/
  package.json
  README.md
  src/
    index.ts
    cli.ts
    core/
      EvolutionOrchestrator.ts
      DesignTeamBuilder.ts
      DesignRunner.ts
      DesignJudge.ts
      DesignSelector.ts
      DesignMerger.ts
      MemberUpskiller.ts
      VirtualFileSystem.ts
      TraceStore.ts
    model/
      ModelProvider.ts
      MockModelProvider.ts
    prompts/
      buildTeam.ts
      runTeam.ts
      judgeDesign.ts
      mergeTeams.ts
      upskillMember.ts
    examples/
      premium-ai-consultancy/
        goal.md
        brand-book.md
    tests/
      virtual-file-system.test.ts
      scoring.test.ts
      selection.test.ts
      trace-store.test.ts
```

## Non-Goals

- Do not copy the Python project directly.
- Do not require MongoDB.
- Do not require unsafe shell execution.
- Do not require web research for v1.
- Do not claim the generated design is objectively best.
- Do not make Cognee mandatory for the basic evolutionary loop.
- Do not hide evaluator prompts.

## Open Product Question

The strongest demo may show both improvement paths:

1. **Team evolution:** the system spawns, fires, scores, and merges full design teams.
2. **Member upskilling:** the self-improving run upgrades a specific role, such as `Visual Designer v2`, based on critique.

That gives the audience a concrete mental model:

> The design agent does not just retry. It learns which teams work and which team members need to get better.
