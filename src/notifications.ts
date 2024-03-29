import { bold, codeBlock } from "@discordjs/builders";
import { User } from "@prisma/client";
import {
  APIEmbedField,
  EmbedBuilder,
  escapeCodeBlock,
  escapeMarkdown,
} from "discord.js";
import { AeriesClient, getClient } from "./aeries.js";
import { client } from "./client.js";
import {
  classesToMap,
  classesWithAssignmentsToMap,
  compareAssignments,
  compareClasses,
} from "./compareData.js";
import { prisma } from "./db.js";
import { logError } from "./logging.js";
import {
  Assignment,
  CategoryData,
  ClassSummary,
  ClassWithAssignments,
} from "./types.js";

type GradesData = {
  classes: ClassWithAssignments[];
};

function formatClass(c: ClassSummary): string {
  return (
    escapeMarkdown(c.name ?? "?") + " - " + escapeMarkdown(c.teacher ?? "?")
  );
}

function parseGradeSummary(gradeSummary: string): number | null {
  const m = /.*\(((\d*\.)?\d+)%\)/g.exec(gradeSummary);
  if (!m) return null;
  const n = Number(m[1]);
  return isNaN(n) ? null : n;
}

function formatRemoved(c: ClassSummary): APIEmbedField {
  return {
    name: "Class Removed",
    value: codeBlock("diff", escapeCodeBlock(`- ${formatClass(c)}`)),
  };
}

function formatAdded(c: ClassSummary): APIEmbedField {
  return {
    name: "Class Added",
    value: codeBlock("diff", escapeCodeBlock(`+ ${formatClass(c)}`)),
  };
}

function formatChanged(old: ClassSummary, c: ClassSummary): APIEmbedField[] {
  // we only care about grade changes for now
  if (
    !old.gradeSummary ||
    !c.gradeSummary ||
    old.gradeSummary === c.gradeSummary
  )
    return [];

  const oldGrade = parseGradeSummary(old.gradeSummary);
  const newGrade = parseGradeSummary(c.gradeSummary);
  let prefix = "Grade changed";
  if (oldGrade !== null && newGrade !== null) {
    if (newGrade > oldGrade) {
      prefix = "📈 Grade increase";
    } else if (newGrade < oldGrade) {
      prefix = "📉 Grade decrease";
    }
  }
  return [
    {
      name: `${prefix} in ${formatClass(c)}`,
      value:
        escapeMarkdown(old.gradeSummary) +
        " :arrow_right: " +
        bold(escapeMarkdown(c.gradeSummary)),
    },
  ];
}

function formatAssignmentScore(a: Assignment): string {
  return (
    `${escapeMarkdown(a.points?.toString() ?? "")}` +
    ` / ${escapeMarkdown(a.maxPoints?.toString() ?? "")}` +
    ` (${escapeMarkdown(a.percent)})`
  );
}

function formatAddedAssignment(c: ClassSummary, a: Assignment): APIEmbedField {
  return {
    name: `✅ ${escapeMarkdown(
      JSON.stringify(a.name.toString())
    )} in ${formatClass(c)} graded`,
    value: `Score: ${bold(formatAssignmentScore(a))}`,
  };
}

function formatRemovedAssignment(
  c: ClassSummary,
  a: Assignment
): APIEmbedField {
  return {
    name:
      `⛔ ` +
      escapeMarkdown(JSON.stringify(a.name)) +
      ` in ${formatClass(c)} deleted`,
    value: `Original score: ${formatAssignmentScore(a)}`,
  };
}

function formatChangedAssignment(
  c: ClassSummary,
  old: Assignment,
  newA: Assignment
): APIEmbedField[] {
  if (old.percent == newA.percent) return [];
  return [
    {
      name:
        `Grade changed on ` +
        escapeMarkdown(JSON.stringify(old.name)) +
        ` in ${formatClass(c)}`,
      value:
        formatAssignmentScore(old) +
        " :arrow_right: " +
        formatAssignmentScore(newA),
    },
  ];
}

function getCachedData(user: User): GradesData | null {
  if (!user.notificationsCache) return null;
  try {
    return JSON.parse(user.notificationsCache);
  } catch (e) {
    return null;
  }
}

async function fetchGradebook(
  client: AeriesClient,
  gradebookUrl: string
): Promise<{ assignments: Assignment[]; categories: CategoryData[] }> {
  const { assignments, categories } = await client.gradebookDetails(
    gradebookUrl
  );
  return {
    assignments: assignments.filter((a) => a.gradingComplete),
    categories,
  };
}

async function processNewUser(
  user: User,
  classes: ClassSummary[],
  client: AeriesClient
) {
  console.log(`Generating first-time data for ${user.discordId}`);
  // we already have the classes, so now fetch the assignments for each class.
  const newClasses: ClassWithAssignments[] = [];
  for (const c of classes.values()) {
    newClasses.push({
      ...c,
      assignments: Array.from(
        (await fetchGradebook(client, c.gradebookUrl)).assignments.values()
      ),
    });
  }
  const newData: GradesData = { classes: newClasses };
  await prisma.user.update({
    where: { id: user.id },
    data: {
      notificationsCache: JSON.stringify(newData),
    },
  });
}

export async function mergeNewClassSummary(
  oldData: ClassWithAssignments[],
  newData: ClassSummary[],
  missing: (c: ClassSummary) => Promise<Assignment[]>
): Promise<Map<string, ClassWithAssignments[]>> {
  const oldMap: Map<string, ClassWithAssignments> =
    classesWithAssignmentsToMap(oldData);
  const newMap: Map<string, ClassSummary> = classesToMap(newData);
  const r = new Map();
  for (const [k, v] of newMap.entries()) {
    const base: ClassWithAssignments = oldMap.get(k) ?? {
      ...v,
      assignments: await missing(v),
    };
    r.set(k, { ...base, ...v });
  }
  return r;
}

function getHiddenAssignments(
  assignments: Assignment[],
  categories: CategoryData[]
): Assignment[] {
  console.log({ assignments, categories });
  const r: Assignment[] = [];
  for (const cat of categories) {
    const catName = cat.cat;
    const catAssignments = assignments.filter(
      (a) => a.gradingComplete && a.category == catName
    );
    const categoryMaxPoints = cat.max;
    const assignmentMaxPoints = catAssignments.reduce(
      (acc, a) => acc + (a.maxPoints ?? 0),
      0
    );
    if (categoryMaxPoints != assignmentMaxPoints) {
      const categoryPoints = cat.points;
      const assignmentPoints = catAssignments.reduce(
        (acc, a) => acc + (a.points ?? 0),
        0
      );
      const hiddenPoints = categoryPoints - assignmentPoints;
      const hiddenMax = categoryMaxPoints - assignmentMaxPoints;
      console.log({
        categoryPoints,
        categoryMaxPoints,
        assignmentPoints,
        assignmentMaxPoints,
      });
      r.push({
        name: `Hidden Assignment - ${catName}`,
        category: catName,
        points: hiddenPoints,
        maxPoints: hiddenMax,
        percent: ((hiddenPoints / hiddenMax) * 100).toFixed(2),
        gradingComplete: true,
      });
    }
  }
  return r;
}

async function getEmbedsForUser(user: User): Promise<APIEmbedField[]> {
  const client = getClient();
  await client.login(user.portalUsername, user.portalPassword);
  // we will need the latest class data no matter what
  const classes = await client.getClasses();

  const oldData = getCachedData(user);
  // has the user just now enabled notifications?
  if (!oldData) {
    await processNewUser(user, classes, client);
    return [];
  }

  // merge the old assignments data and the new class data
  const oldMap: Map<string, ClassWithAssignments> = classesWithAssignmentsToMap(
    oldData.classes
  );
  const newMap: Map<string, ClassSummary> = classesToMap(classes);
  const classesWithAssignments = new Map<string, ClassWithAssignments>();
  for (const [k, v] of newMap.entries()) {
    console.log("Fetching missing assignments...");
    classesWithAssignments.set(k, {
      ...v,
      // if this class was just added and we don't have the assignments for it yet,
      //  fetch them.
      assignments:
        oldMap.get(k)?.assignments ??
        (await fetchGradebook(client, v.gradebookUrl)).assignments,
    });
  }

  const { removed, added, changed } = compareClasses(oldData.classes, classes);
  // for every class that changed, compare the cached assignments to the current
  //  assignments
  let assignmentEmbeds: APIEmbedField[] = [];
  for (const [oldClass, newClass] of changed) {
    console.log("Fetching changed classes...");
    // sanity check. This should always pass due to the implementation of
    //  compareClasses
    if (oldClass.name !== newClass.name) continue;
    const oldAssignments = classesWithAssignments.get(
      newClass.name
    )!.assignments;
    let { assignments: newAssignments, categories: newCategories } =
      await fetchGradebook(client, newClass.gradebookUrl);
    newAssignments = newAssignments.concat(
      getHiddenAssignments(newAssignments, newCategories)
    );
    // record the new assignmnets to be stored in the DB later
    classesWithAssignments.set(newClass.name, {
      ...newClass,
      assignments: newAssignments,
    });
    const { added, removed, changed } = compareAssignments(
      oldAssignments,
      newAssignments
    );
    assignmentEmbeds = assignmentEmbeds
      .concat(added.map((a) => formatAddedAssignment(newClass, a)))
      .concat(removed.map((a) => formatRemovedAssignment(newClass, a)))
      .concat(
        changed.flatMap(([a, b]) => formatChangedAssignment(newClass, a, b))
      );
  }

  const newData: GradesData = {
    classes: Array.from(classesWithAssignments.values()),
  };
  const newDataString = JSON.stringify(newData);
  if (newDataString !== user.notificationsCache) {
    await prisma.user.update({
      where: { id: user.id },
      data: { notificationsCache: newDataString },
    });
  }

  const embeds = removed
    .map(formatRemoved)
    .concat(added.map(formatAdded))
    .concat(assignmentEmbeds) // put assignment changes above the grade change
    .concat(changed.flatMap(([a, b]) => formatChanged(a, b)));
  return embeds;
}

async function sendAlert(discordId: string, embeds: APIEmbedField[]) {
  if (!embeds.length) return;
  const user = await client.users.fetch(discordId);
  await user.send({
    content: ":warning: Grade Alert!",
    embeds: [new EmbedBuilder().setColor(0x284b98).addFields(...embeds)],
  });
}

async function processUser(user: User) {
  const embeds = await getEmbedsForUser(user);
  // send the embeds, 10 at a time
  const MAX_EMBEDS = 10;
  for (let i = 0; i < embeds.length; i += MAX_EMBEDS) {
    const chunk = embeds.slice(i, i + MAX_EMBEDS);
    await sendAlert(user.discordId, chunk);
  }
}

export async function sendNotifications() {
  console.log("Processing notifications...");
  const toProcess = await prisma.user.findMany({
    where: { notificationsEnabled: true },
  });
  for (const user of toProcess) {
    try {
      await processUser(user);
    } catch (e) {
      // TODO: Handle login errors
      await logError(e);
      continue;
    }
  }
  setTimeout(sendNotifications, 60 * 1000);
}
