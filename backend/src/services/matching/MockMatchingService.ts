import type { AIProvider, AIRecommendationPayload, MatchRequestInput, MatchingService, MatchingSession } from '../../types';
import { buildMatchingSession } from './MatchingSessionBuilder';

export class MockAIProvider implements AIProvider {
  async generateRecommendations({ students, mentors }: MatchRequestInput): Promise<AIRecommendationPayload[]> {
    const results: AIRecommendationPayload[] = [];

    mentors.forEach((mentor, mentorIndex) => {
      const order = Array.from({ length: students.length }, (_, index) => index)
        .map((studentIndex) => ({
          studentIndex,
          score: Math.max(65, 96 - ((mentorIndex + studentIndex) % 9) * 5 - (studentIndex % 3) * 2),
        }))
        .sort((a, b) => b.score - a.score);

      const selectedOrder = order.slice(0, Math.min(3, students.length));
      const alternativeOrder = order.slice(Math.min(3, students.length), Math.min(5, students.length));

      selectedOrder.forEach((entry) => {
        const student = students[entry.studentIndex];
        results.push({
          mentorId: mentor.id,
          studentId: student.id,
          score: entry.score,
          reason: `${mentor.name} is a strong fit for ${student.name} because the project aligns with ${student.desiredSkills || 'the student interests'} and ${student.topicsForExpertConsultation || 'consultation topics'}.`,
          category: 'selected',
          assignedToMentorId: null,
        });
      });

      alternativeOrder.forEach((entry) => {
        const student = students[entry.studentIndex];
        results.push({
          mentorId: mentor.id,
          studentId: student.id,
          score: entry.score,
          reason: `${mentor.name} is a useful alternative for ${student.name} because the profile remains relevant to ${student.desiredSkills || 'the student interests'} and ${student.topicsForExpertConsultation || 'consultation topics'}.`,
          category: 'alternative',
          assignedToMentorId: null,
        });
      });
    });

    return results;
  }
}

export class MockMatchingService implements MatchingService {
  constructor(private readonly aiProvider: AIProvider) {}

  async run(input: MatchRequestInput): Promise<MatchingSession> {
    const recommendations = await this.aiProvider.generateRecommendations(input);
    return buildMatchingSession(input, recommendations);
  }
}
