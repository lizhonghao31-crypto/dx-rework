import {scheduleCanAdvance,type CockpitHomeOrder,type CockpitHomeResult,type JourneyResult} from '@dx-rework/contracts/digital-production-journey';

export function projectCockpitHome(result:JourneyResult):CockpitHomeResult {
  const items = result.items.map((order):CockpitHomeOrder => {
    const {fixedSchedule:schedule,visualProgress:visual,businessProgress:business}=order;
    const home:CockpitHomeOrder = {
      id:order.id,
      orderId:order.orderId,
      styleName:order.styleName,
      designStyleNo:order.designStyleNo,
      customer:order.customer,
      merchandisers:order.merchandisers,
      lines:order.lines,
      // Each home selection and risk lookup is restricted to current nodes.
      stages:order.stages.map(stage=>({...stage,nodes:stage.nodes.filter(node=>node.current)})),
    };
    if(order.styleImageUrl!==undefined)home.styleImageUrl=order.styleImageUrl;
    if(order.identity)home.identity=order.identity;
    if(order.poDeliveryDates)home.poDeliveryDates=order.poDeliveryDates;
    if(order.deliveryRisks)home.deliveryRisks=order.deliveryRisks;
    if(order.cockpitFacts)home.cockpitFacts=order.cockpitFacts;
    if(order.display)home.display={mainState:order.display.mainState};
    if(business?.quantities)home.businessProgress={quantities:business.quantities};
    if(visual)home.visualProgress={
      ...(visual.delivery?{delivery:visual.delivery}:{}),
      startedAt:visual.startedAt,
      actualRatio:visual.actualRatio,
      timeRatio:visual.timeRatio,
      actual:visual.actual,
      expected:visual.expected,
    };
    if(schedule)home.fixedSchedule={
      state:schedule.state,
      asOf:schedule.asOf,
      ...(schedule.observationMode?{observationMode:schedule.observationMode}:{}),
      clockCanAdvance:scheduleCanAdvance(schedule),
      scopes:schedule.scopes.map(({lineId,state,customerDuePassed,completionEstimate})=>({
        lineId,state,customerDuePassed,...(completionEstimate?{completionEstimate}:{}),
      })),
      // A recognized empty framework is distinct from using legacy PO dates.
      ...(schedule.framework?{framework:{scopes:schedule.framework.scopes.map(({customerDate})=>({customerDate}))}}:{}),
    };
    return home;
  });
  return {...result,items};
}
