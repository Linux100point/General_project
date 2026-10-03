import type OpenAI from 'openai';
import { z } from 'zod';
import type { AIRecommendationPayload, MatchRequestInput, MentorProfile } from '../../types';

const RecommendationSchema = z.object({
  studentId: z.string().min(1),
  score: z.number().int().min(0).max(100),
  reason: z.string().trim().min(1),
}).strict();

const MentorRecommendationsSchema = z.object({
  mentorId: z.string().min(1),
  selected: z.array(RecommendationSchema).length(3),
  alternatives: z.array(RecommendationSchema).length(2),
}).strict();

const MatchingResponseSchema = z.object({
  mentors: z.array(MentorRecommendationsSchema),
}).strict();

export class MatchingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatchingConfigurationError';
  }
}

export class OpenAIProvider {
  constructor(
    private readonly client: Pick<OpenAI, 'responses'> | null,
    private readonly model: string,
  ) {}

  async generateRecommendations(input: MatchRequestInput): Promise<AIRecommendationPayload[]> {
    if (!this.client) {
      throw new MatchingConfigurationError('OpenAI matching requires OPENAI_API_KEY on the backend.');
    }

    const profiles = input.mentorProfiles;
    if (!profiles || profiles.length !== input.mentors.length || profiles.length === 0) {
      throw new Error('Every matching mentor must have a normalized CV profile.');
    }
    if (input.students.length < 5) {
      throw new Error('At least five students are required to produce three selected and two alternative recommendations per mentor.');
    }

    const mentorIds = input.mentors.map((mentor) => mentor.id);
    const studentIds = input.students.map((student) => student.id);
    const responseSchema = createMatchingResponseSchema(mentorIds, studentIds);
    const studentData = input.students.map((student) => ({
      studentId: student.id,
      fullName: student.name,
      desiredSkillsAndTechnologies: student.desiredSkills,
      topicsForExpertConsultation: student.topicsForExpertConsultation,
      projectOverview: student.projectOverview,
      mentorshipSupportNeeds: student.mentorshipSupportNeeds,
    }));

    const response = await this.client.responses.create({
      model: this.model,
      store: false,
      reasoning: { effort: 'high' },
      max_output_tokens: 12000,
      input: [
        {
          role: 'system',
          content: 'You are a semantic mentor-student compatibility recommender. Evaluate each supplied mentor against the complete supplied student goals, requested technologies, project overview, consultation topics, and support needs. Use only the supplied mentor and student IDs. Use only mentor expertise supported by the supplied CV profile and evidence. Do not invent qualifications. Score compatibility from 0 to 100; this score is not a probability of success. Return exactly three selected and two distinct alternatives for every mentor, ranked from strongest to weakest within each list. Recommendations may overlap between different mentors. Do not make final assignments: the backend applies the one-student-one-final-mentor rule. Reasons must be concise and grounded in specific mentor evidence and student needs.',
        },
        {
          role: 'user',
          content: JSON.stringify({ mentors: profiles, students: studentData }),
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'mentor_student_recommendations',
          strict: true,
          schema: responseSchema,
        },
      },
    });

    if (response.status !== 'completed') {
      throw new Error('OpenAI matching response was incomplete.');
    }

    const messageItems = response.output.filter((item) => item.type === 'message');
    if (messageItems.some((item) => item.type === 'message' && item.content.some((part) => part.type === 'refusal'))) {
      throw new Error('OpenAI declined to generate matching recommendations.');
    }

    let parsedResponse: unknown;
    try {
      parsedResponse = JSON.parse(response.output_text);
    } catch {
      throw new Error('OpenAI matching response was not valid JSON.');
    }

    return validateMatchingRecommendations(parsedResponse, profiles, input.students);
  }
}

export function createMatchingResponseSchema(mentorIds: string[], studentIds: string[]) {
  if (!mentorIds.length || !studentIds.length) {
    throw new Error('Matching schema requires at least one mentor and one student.');
  }

  const recommendationSchema = {
    type: 'object',
    properties: {
      studentId: { type: 'string', enum: studentIds },
      score: { type: 'integer', minimum: 0, maximum: 100 },
      reason: { type: 'string' },
    },
    required: ['studentId', 'score', 'reason'],
    additionalProperties: false,
  };

  return {
    type: 'object',
    properties: {
      mentors: {
        type: 'array',
        minItems: mentorIds.length,
        maxItems: mentorIds.length,
        items: {
          type: 'object',
          properties: {
            mentorId: { type: 'string', enum: mentorIds },
            selected: {
              type: 'array',
              minItems: 3,
              maxItems: 3,
              items: recommendationSchema,
            },
            alternatives: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: recommendationSchema,
            },
          },
          required: ['mentorId', 'selected', 'alternatives'],
          additionalProperties: false,
        },
      },
    },
    required: ['mentors'],
    additionalProperties: false,
  };
}

export function validateMatchingRecommendations(
  value: unknown,
  profiles: MentorProfile[],
  students: MatchRequestInput['students'],
): AIRecommendationPayload[] {
  const parsed = MatchingResponseSchema.parse(value);
  const expectedMentorIds = new Set(profiles.map((profile) => profile.mentorId));
  const validStudentIds = new Set(students.map((student) => student.id));

  if (parsed.mentors.length !== profiles.length) {
    throw new Error('Matching response must contain exactly one result per mentor.');
  }

  const seenMentorIds = new Set<string>();
  const recommendations: AIRecommendationPayload[] = [];

  for (const mentorResult of parsed.mentors) {
    if (!expectedMentorIds.has(mentorResult.mentorId)) {
      throw new Error(`Matching response contains unknown mentor ID "${mentorResult.mentorId}".`);
    }
    if (seenMentorIds.has(mentorResult.mentorId)) {
      throw new Error(`Matching response contains duplicate mentor ID "${mentorResult.mentorId}".`);
    }
    seenMentorIds.add(mentorResult.mentorId);

    const selectedStudentIds = new Set<string>();
    for (const item of mentorResult.selected) {
      validateRecommendationStudentId(item.studentId, validStudentIds);
      if (selectedStudentIds.has(item.studentId)) {
        throw new Error(`Mentor "${mentorResult.mentorId}" has duplicate selected student recommendations.`);
      }
      selectedStudentIds.add(item.studentId);
      recommendations.push({
        mentorId: mentorResult.mentorId,
        studentId: item.studentId,
        score: item.score,
        reason: item.reason,
        category: 'selected',
        assignedToMentorId: null,
      });
    }

    const alternativeStudentIds = new Set<string>();
    for (const item of mentorResult.alternatives) {
      validateRecommendationStudentId(item.studentId, validStudentIds);
      if (selectedStudentIds.has(item.studentId) || alternativeStudentIds.has(item.studentId)) {
        throw new Error(`Mentor "${mentorResult.mentorId}" has duplicate or overlapping recommendations.`);
      }
      alternativeStudentIds.add(item.studentId);
      recommendations.push({
        mentorId: mentorResult.mentorId,
        studentId: item.studentId,
        score: item.score,
        reason: item.reason,
        category: 'alternative',
        assignedToMentorId: null,
      });
    }
  }

  if (seenMentorIds.size !== expectedMentorIds.size) {
    throw new Error('Matching response omitted one or more mentors.');
  }

  return recommendations;
}

function validateRecommendationStudentId(studentId: string, validStudentIds: Set<string>): void {
  if (!validStudentIds.has(studentId)) {
    throw new Error(`Matching response contains unknown student ID "${studentId}".`);
  }
}