import { Test, TestingModule } from '@nestjs/testing';
import { AgentGatewayService } from './agent-gateway.service';

describe('AgentGatewayService', () => {
  let service: AgentGatewayService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AgentGatewayService],
    }).compile();

    service = module.get<AgentGatewayService>(AgentGatewayService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

