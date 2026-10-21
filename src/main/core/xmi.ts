import type { Actor, Diagram, Project, UcPackage, UseCase } from '@shared/types'
import { EA_COLOR_VALUE } from '@shared/constants'
import { diagramNameOf, packageLabel, useCaseLabel } from '@shared/idrules'
import { EA_ROOT_CLASS_ID, GuidFactory } from './eaid'
import { xmlAttr, T } from './xml'
import {
  actorsUsedIn,
  defaultActorPosition,
  resolveActorPositions,
  resolveUseCasePositions,
  useCasesOf,
  useCaseNodeSize
} from './layout'

interface DgmRef {
  dgm: Diagram
  diagramId: string
}

interface PkgRef {
  pkg: UcPackage
  classifierRoleId: string
  packageId: string
  diagrams: DgmRef[]
}

interface AssocRef {
  id: string
  localId: number
  actorGuid: string
  useCaseGuid: string
  /** 이 연결선이 그려질 다이어그램 */
  diagramUid: string
  useCaseUid: string
}

interface DepRef {
  id: string
  localId: number
  clientGuid: string
  supplierGuid: string
  stereotype: 'include' | 'extend'
  diagramUid: string
}

export interface XmiBuildResult {
  xml: string
  stats: {
    packages: number
    useCases: number
    actors: number
    associations: number
    diagrams: number
  }
}

const tv = (indent: number, tag: string, value: string): string =>
  `${T(indent)}<UML:TaggedValue tag="${tag}" value="${value}"/>`

export function buildXmi(project: Project, opts: { timestamp?: string } = {}): XmiBuildResult {
  const ts = opts.timestamp ?? formatTimestamp(new Date())
  /*
   * GUID 네임스페이스. 프로젝트 ID 가 비어 있으면 **시스템명이라도 쓴다** —
   * 고정 문자열로 떨어지면 서로 다른 산출물이 같은 네임스페이스를 공유하게 된다.
   * (정상 경로에서는 normalize 가 프로젝트 ID 를 반드시 채워 준다)
   */
  const g = new GuidFactory(
    project.metadata.projectId || project.metadata.systemName || 'EAUCS'
  )

  /* ---------- 골격 패키지 GUID ---------- */
  const modelPackageId = g.eapk('root:model')
  const modelCollabId = g.eaid('root:model:collab')
  const ucModel = g.packagePair('root:usecase-model')
  const ucCollabId = g.eaid('root:usecase-model:collab')
  const actorsPkg = g.packagePair('root:actors')

  let localId = 100

  /* ---------- UCD 패키지 (요구사항 1건 = 패키지 1개, Use Case Model 바로 아래) ---------- */
  const pkgRefs: PkgRef[] = project.packages.map((pkg) => {
    const pair = g.packagePair(`package:${pkg.uid}`)
    return {
      pkg,
      classifierRoleId: pair.classifierRoleId,
      packageId: pair.packageId,
      diagrams: pkg.diagrams.map((dgm) => ({ dgm, diagramId: g.eaid(`diagram:${dgm.uid}`) }))
    }
  })

  /* ---------- 액터 / 유스케이스 GUID ---------- */
  const actorGuid = new Map<string, string>()
  const actorLocal = new Map<string, number>()
  project.actors.forEach((a) => {
    actorGuid.set(a.uid, g.eaid(`actor:${a.uid}`))
    actorLocal.set(a.uid, localId++)
  })

  const ucGuid = new Map<string, string>()
  const ucLocal = new Map<string, number>()
  const ucPkgId = new Map<string, string>()
  for (const ref of pkgRefs) {
    for (const uc of ref.pkg.useCases) {
      ucGuid.set(uc.uid, g.eaid(`usecase:${uc.uid}`))
      ucLocal.set(uc.uid, localId++)
      ucPkgId.set(uc.uid, ref.packageId)
    }
  }

  /* ---------- 관계 ---------- */
  let connLocal = 1000
  const assocs: AssocRef[] = []
  const deps: DepRef[] = []
  for (const ref of pkgRefs) {
    for (const uc of ref.pkg.useCases) {
      for (const aUid of uc.actorUids) {
        const ag = actorGuid.get(aUid)
        const ug = ucGuid.get(uc.uid)
        if (!ag || !ug) continue
        assocs.push({
          id: g.eaid(`assoc:${aUid}->${uc.uid}`),
          localId: connLocal++,
          actorGuid: ag,
          useCaseGuid: ug,
          diagramUid: uc.diagramUid,
          useCaseUid: uc.uid
        })
      }
      const pushDep = (targets: string[], stereotype: 'include' | 'extend'): void => {
        for (const target of targets) {
          const from = ucGuid.get(uc.uid)
          const to = ucGuid.get(target)
          if (!from || !to) continue
          deps.push({
            id: g.eaid(`${stereotype}:${uc.uid}->${target}`),
            localId: connLocal++,
            clientGuid: from,
            supplierGuid: to,
            stereotype,
            diagramUid: uc.diagramUid
          })
        }
      }
      pushDep(uc.includeUids, 'include')
      pushDep(uc.extendUids, 'extend')
    }
  }

  /* ================================================================== */
  /* ClassifierRole (EA 패키지 메타데이터)                                */
  /* ================================================================== */

  const classifierRole = (args: {
    indent: number
    name: string
    id: string
    parentPackageId: string
    alias?: string
    localId: number
    tpos: number
  }): string => {
    const i = args.indent
    const lines = [
      `${T(i)}<UML:ClassifierRole name="${xmlAttr(args.name)}" xmi.id="${args.id}" visibility="public" base="${EA_ROOT_CLASS_ID}">`,
      `${T(i + 1)}<UML:ModelElement.taggedValue>`,
      tv(i + 2, 'isAbstract', 'false'),
      tv(i + 2, 'isSpecification', 'false'),
      tv(i + 2, 'ea_stype', 'Package'),
      tv(i + 2, 'ea_ntype', '0'),
      tv(i + 2, 'version', '1.0'),
      tv(i + 2, 'isActive', 'false'),
      tv(i + 2, 'package', args.parentPackageId),
      tv(i + 2, 'date_created', ts),
      tv(i + 2, 'date_modified', ts),
      tv(i + 2, 'package2', args.id),
      ...(args.alias ? [tv(i + 2, 'alias', xmlAttr(args.alias))] : []),
      tv(i + 2, 'author', xmlAttr(project.metadata.author || 'ea-usecase-studio')),
      tv(i + 2, 'phase', '1.0'),
      tv(i + 2, 'complexity', '1'),
      tv(i + 2, 'status', 'Proposed'),
      tv(i + 2, 'tpos', String(args.tpos)),
      tv(i + 2, 'ea_localid', String(args.localId)),
      tv(i + 2, 'ea_eleType', 'package'),
      tv(
        i + 2,
        'style',
        'BackColor=-1;BorderColor=-1;BorderWidth=-1;FontColor=-1;VSwimLanes=1;HSwimLanes=1;BorderStyle=0;'
      ),
      `${T(i + 1)}</UML:ModelElement.taggedValue>`,
      `${T(i)}</UML:ClassifierRole>`
    ]
    return lines.join('\n')
  }

  let crLocal = 20
  const ucModelClassifierRole = classifierRole({
    indent: 6,
    name: 'Use Case Model',
    id: ucModel.classifierRoleId,
    parentPackageId: modelPackageId,
    localId: crLocal++,
    tpos: 0
  })

  const pkgClassifierRoles = pkgRefs.map((ref, i) =>
    classifierRole({
      indent: 9,
      name: packageLabel(ref.pkg),
      id: ref.classifierRoleId,
      parentPackageId: ucModel.packageId,
      alias: ref.pkg.code,
      localId: crLocal++,
      // Actors 가 tpos 0 이므로 UCD 패키지는 1부터
      tpos: i + 1
    })
  )

  const actorsClassifierRole = classifierRole({
    indent: 9,
    name: 'Actors',
    id: actorsPkg.classifierRoleId,
    parentPackageId: ucModel.packageId,
    localId: crLocal++,
    tpos: 0
  })

  /* ================================================================== */
  /* UseCase / Actor 요소                                                */
  /* ================================================================== */

  const useCaseXml = (uc: UseCase, pkg: UcPackage, indent: number): string => {
    const pid = ucPkgId.get(uc.uid) as string
    const back = EA_COLOR_VALUE[pkg.color] ?? '-1'
    const i = indent
    return [
      `${T(i)}<UML:UseCase name="${xmlAttr(useCaseLabel(uc.code, uc.name))}" xmi.id="${ucGuid.get(uc.uid)}" visibility="public" namespace="${pid}" isRoot="false" isLeaf="false" isAbstract="false">`,
      `${T(i + 1)}<UML:ModelElement.taggedValue>`,
      tv(i + 2, 'documentation', xmlAttr(buildDocumentation(uc, pkg))),
      tv(i + 2, 'isSpecification', 'false'),
      tv(i + 2, 'ea_stype', 'UseCase'),
      tv(i + 2, 'ea_ntype', '0'),
      tv(i + 2, 'version', '1.0'),
      tv(i + 2, 'package', pid),
      tv(i + 2, 'date_created', ts),
      tv(i + 2, 'date_modified', ts),
      tv(i + 2, 'package_name', xmlAttr(packageLabel(pkg))),
      tv(i + 2, 'phase', '1.0'),
      tv(i + 2, 'alias', xmlAttr(uc.code)),
      tv(i + 2, 'author', xmlAttr(project.metadata.author || 'ea-usecase-studio')),
      tv(i + 2, 'complexity', '1'),
      tv(i + 2, 'status', 'Proposed'),
      tv(i + 2, 'ea_localid', String(ucLocal.get(uc.uid))),
      tv(i + 2, 'ea_eleType', 'element'),
      tv(
        i + 2,
        'style',
        `BackColor=${back};BorderColor=-1;BorderWidth=-1;FontColor=-1;VSwimLanes=1;HSwimLanes=1;BorderStyle=0;`
      ),
      `${T(i + 1)}</UML:ModelElement.taggedValue>`,
      `${T(i)}</UML:UseCase>`
    ].join('\n')
  }

  const actorXml = (a: Actor, index: number, indent: number): string => {
    const i = indent
    return [
      `${T(i)}<UML:Actor name="${xmlAttr(a.name)}" xmi.id="${actorGuid.get(a.uid)}" visibility="public" namespace="${actorsPkg.packageId}" isRoot="false" isLeaf="false" isAbstract="false">`,
      `${T(i + 1)}<UML:ModelElement.taggedValue>`,
      tv(i + 2, 'documentation', xmlAttr(a.description)),
      tv(i + 2, 'isSpecification', 'false'),
      tv(i + 2, 'ea_stype', 'Actor'),
      tv(i + 2, 'ea_ntype', '0'),
      tv(i + 2, 'version', '1.0'),
      tv(i + 2, 'package', actorsPkg.packageId),
      tv(i + 2, 'date_created', ts),
      tv(i + 2, 'date_modified', ts),
      tv(i + 2, 'package_name', 'Actors'),
      tv(i + 2, 'phase', '1.0'),
      tv(i + 2, 'author', xmlAttr(project.metadata.author || 'ea-usecase-studio')),
      tv(i + 2, 'complexity', '1'),
      tv(i + 2, 'status', 'Proposed'),
      tv(i + 2, 'tpos', String(index)),
      tv(i + 2, 'ea_localid', String(actorLocal.get(a.uid))),
      tv(i + 2, 'ea_eleType', 'element'),
      tv(
        i + 2,
        'style',
        'BackColor=-1;BorderColor=-1;BorderWidth=-1;FontColor=-1;VSwimLanes=1;HSwimLanes=1;BorderStyle=0;'
      ),
      `${T(i + 1)}</UML:ModelElement.taggedValue>`,
      `${T(i)}</UML:Actor>`
    ].join('\n')
  }

  /* ================================================================== */
  /* 패키지 트리                                                         */
  /* ================================================================== */

  const packageTags = (
    indent: number,
    parentId: string,
    tpos: number,
    alias?: string,
    documentation?: string
  ): string =>
    [
      `${T(indent)}<UML:ModelElement.taggedValue>`,
      tv(indent + 1, 'parent', parentId),
      ...(documentation?.trim()
        ? [tv(indent + 1, 'documentation', xmlAttr(documentation))]
        : []),
      tv(indent + 1, 'created', ts),
      tv(indent + 1, 'modified', ts),
      tv(indent + 1, 'iscontrolled', 'FALSE'),
      tv(indent + 1, 'version', '1.0'),
      tv(indent + 1, 'isprotected', 'FALSE'),
      tv(indent + 1, 'usedtd', 'FALSE'),
      tv(indent + 1, 'logxml', 'FALSE'),
      ...(alias ? [tv(indent + 1, 'alias', xmlAttr(alias))] : []),
      tv(indent + 1, 'phase', '1.0'),
      tv(indent + 1, 'status', 'Proposed'),
      tv(indent + 1, 'author', xmlAttr(project.metadata.author || 'ea-usecase-studio')),
      tv(indent + 1, 'complexity', '1'),
      tv(indent + 1, 'ea_stype', 'Public'),
      tv(indent + 1, 'tpos', String(tpos)),
      `${T(indent)}</UML:ModelElement.taggedValue>`
    ].join('\n')

  /**
   * UCD 패키지 — `Use Case Model` 바로 아래에 평면으로 나열된다.
   * 유스케이스는 다이어그램이 아니라 **패키지**에 속한다(EA와 같은 구조).
   */
  const ucdPackageXml = (ref: PkgRef, tpos: number): string => {
    const i = 9
    const ucs = ref.pkg.useCases.map((uc) => useCaseXml(uc, ref.pkg, i + 2))
    return [
      `${T(i)}<UML:Package name="${xmlAttr(packageLabel(ref.pkg))}" xmi.id="${ref.packageId}" isRoot="false" isLeaf="false" isAbstract="false" visibility="public">`,
      packageTags(i + 1, ucModel.packageId, tpos, ref.pkg.code, ref.pkg.description),
      `${T(i + 1)}<UML:Namespace.ownedElement>`,
      // 빈 자리 주석은 ASCII 만 — 주석 안은 &#nnn; 치환이 안 되고 파일은 latin1 로 쓰여 한글이 0x00 등으로 깨진다
      ucs.length ? ucs.join('\n') : `${T(i + 2)}<!-- no use cases -->`,
      `${T(i + 1)}</UML:Namespace.ownedElement>`,
      `${T(i)}</UML:Package>`
    ].join('\n')
  }

  const actorsPackageXml = ((): string => {
    const i = 9
    const items = project.actors.map((a, idx) => actorXml(a, idx, i + 2))
    return [
      `${T(i)}<UML:Package name="Actors" xmi.id="${actorsPkg.packageId}" isRoot="false" isLeaf="false" isAbstract="false" visibility="public">`,
      packageTags(i + 1, ucModel.packageId, 0),
      `${T(i + 1)}<UML:Namespace.ownedElement>`,
      items.length ? items.join('\n') : `${T(i + 2)}<!-- no actors -->`,
      `${T(i + 1)}</UML:Namespace.ownedElement>`,
      `${T(i)}</UML:Package>`
    ].join('\n')
  })()

  /* ================================================================== */
  /* 관계 XML                                                            */
  /* ================================================================== */

  const associationXmls = assocs.map((a) => {
    const i = 9
    return [
      `${T(i)}<UML:Association xmi.id="${a.id}" visibility="public" isRoot="false" isLeaf="false" isAbstract="false">`,
      `${T(i + 1)}<UML:ModelElement.taggedValue>`,
      tv(i + 2, 'style', '3'),
      tv(i + 2, 'ea_type', 'Association'),
      tv(i + 2, 'direction', 'Source -&gt; Destination'),
      tv(i + 2, 'linemode', '3'),
      tv(i + 2, 'linecolor', '-1'),
      tv(i + 2, 'linewidth', '0'),
      tv(i + 2, 'seqno', '0'),
      tv(i + 2, 'headStyle', '0'),
      tv(i + 2, 'lineStyle', '0'),
      tv(i + 2, 'ea_localid', String(a.localId)),
      tv(i + 2, 'privatedata5', 'SX=0;SY=0;EX=0;EY=0;EDGE=3;'),
      tv(i + 2, 'virtualInheritance', '0'),
      `${T(i + 1)}</UML:ModelElement.taggedValue>`,
      `${T(i + 1)}<UML:Association.connection>`,
      `${T(i + 2)}<UML:AssociationEnd aggregation="none" isOrdered="false" targetScope="instance" changeable="none" isNavigable="false" type="${a.actorGuid}"/>`,
      `${T(i + 2)}<UML:AssociationEnd aggregation="none" isOrdered="false" targetScope="instance" changeable="none" isNavigable="true" type="${a.useCaseGuid}"/>`,
      `${T(i + 1)}</UML:Association.connection>`,
      `${T(i)}</UML:Association>`
    ].join('\n')
  })

  const dependencyXmls = deps.map((d) => {
    const i = 9
    return [
      `${T(i)}<UML:Dependency xmi.id="${d.id}" client="${d.clientGuid}" supplier="${d.supplierGuid}" visibility="public" isSpecification="false">`,
      `${T(i + 1)}<UML:ModelElement.stereotype>`,
      `${T(i + 2)}<UML:Stereotype name="${d.stereotype}"/>`,
      `${T(i + 1)}</UML:ModelElement.stereotype>`,
      `${T(i + 1)}<UML:ModelElement.taggedValue>`,
      tv(i + 2, 'style', '3'),
      tv(i + 2, 'ea_type', 'Dependency'),
      tv(i + 2, 'direction', 'Source -&gt; Destination'),
      tv(i + 2, 'linemode', '3'),
      tv(i + 2, 'linecolor', '-1'),
      tv(i + 2, 'linewidth', '0'),
      tv(i + 2, 'seqno', '0'),
      tv(i + 2, 'ea_localid', String(d.localId)),
      tv(i + 2, 'privatedata5', 'SX=0;SY=0;EX=0;EY=0;EDGE=3;'),
      `${T(i + 1)}</UML:ModelElement.taggedValue>`,
      `${T(i)}</UML:Dependency>`
    ].join('\n')
  })

  /* ================================================================== */
  /* 유스케이스 확장 속성 (EA Tagged Value)                               */
  /* ================================================================== */

  const ucTaggedValues: string[] = []
  for (const ref of pkgRefs) {
    for (const uc of ref.pkg.useCases) {
      const guid = ucGuid.get(uc.uid) as string
      const add = (tag: string, value: string): void => {
        ucTaggedValues.push(
          `${T(2)}<UML:TaggedValue tag="${tag}" xmi.id="${g.eaid(`tv:${uc.uid}:${tag}`)}" value="${xmlAttr(value)}" modelElement="${guid}"/>`
        )
      }
      add('req_id', uc.reqId || ref.pkg.reqId)
      add('priority', uc.priority)
      add('difficulty', uc.difficulty)
      add('main_flow', uc.mainFlow)
      add('alt_flow', uc.altFlow)
      add('exception_flow', uc.exceptionFlow)
      add('precondition', uc.precondition)
      add('postcondition', uc.postcondition)
      if (uc.specialRequirement) add('special_requirement', uc.specialRequirement)
      if (uc.note) add('note', uc.note)
    }
  }

  /* ================================================================== */
  /* 다이어그램                                                          */
  /* ================================================================== */

  const EA_STYLE =
    'ShowPrivate=1;ShowProtected=1;ShowPublic=1;HideRelationships=0;Locked=0;Border=1;HighlightForeign=1;PackageContents=1;SequenceNotes=0;ScalePrintImage=0;PPgs.cx=1;PPgs.cy=1;DocSize.cx=827;DocSize.cy=1169;ShowDetails=0;Orientation=P;Zoom=100;ShowTags=0;OpParams=1;VisibleAttributeDetail=0;ShowOpRetType=1;ShowIcons=1;CollabNums=0;HideProps=0;ShowReqs=0;ShowCons=0;PaperSize=9;HideParents=0;UseAlias=0;HideAtts=0;HideOps=0;HideStereo=0;HideElemStereo=0;ShowTests=0;ShowMaint=0;ConnectorNotation=UML 2.1;ExplicitNavigability=0;AdvancedElementProps=1;AdvancedFeatureProps=1;AdvancedConnectorProps=1;ShowNotes=0;SuppressBrackets=0;SuppConnectorLabels=0;PrintPageHeadFoot=0;ShowAsList=0;'
  const STYLE_EX =
    'SaveTag=0;ExcludeRTF=0;DocAll=0;HideQuals=0;AttPkg=1;ShowTests=0;ShowMaint=0;SuppressFOC=1;MatrixActive=0;SwimlanesActive=1;MatrixLineWidth=1;MatrixLocked=0;TConnectorNotation=UML 2.1;TExplicitNavigability=0;AdvancedElementProps=1;AdvancedFeatureProps=1;AdvancedConnectorProps=1;MDGDgm=;STBLDgm=;ShowNotes=0;VisibleAttributeDetail=0;ShowOpRetType=1;SuppressBrackets=0;SuppConnectorLabels=0;PrintPageHeadFoot=0;ShowAsList=0;SuppressedCompartments=;'

  const diagramShell = (args: {
    name: string
    id: string
    ownerPackageId: string
    localId: number
    elements: string[]
  }): string => {
    const i = 2
    return [
      `${T(i)}<UML:Diagram name="${xmlAttr(args.name)}" xmi.id="${args.id}" diagramType="UseCaseDiagram" owner="${args.ownerPackageId}" toolName="Enterprise Architect 2.5">`,
      `${T(i + 1)}<UML:ModelElement.taggedValue>`,
      tv(i + 2, 'version', '1.0'),
      tv(i + 2, 'created_date', ts),
      tv(i + 2, 'modified_date', ts),
      tv(i + 2, 'package', args.ownerPackageId),
      tv(i + 2, 'type', 'Use Case'),
      tv(
        i + 2,
        'swimlanes',
        'locked=false;orientation=0;width=0;inbar=false;names=false;color=-1;bold=false;fcol=0;;cls=0;'
      ),
      tv(i + 2, 'matrixitems', 'locked=false;matrixactive=false;swimlanesactive=true;width=1;'),
      tv(i + 2, 'ea_localid', String(args.localId)),
      tv(i + 2, 'EAStyle', EA_STYLE),
      tv(i + 2, 'styleex', STYLE_EX),
      `${T(i + 1)}</UML:ModelElement.taggedValue>`,
      `${T(i + 1)}<UML:Diagram.element>`,
      args.elements.length ? args.elements.join('\n') : `${T(i + 2)}<!-- empty -->`,
      `${T(i + 1)}</UML:Diagram.element>`,
      `${T(i)}</UML:Diagram>`
    ].join('\n')
  }

  /*
   * 패키지 하나에 다이어그램이 여러 개일 수 있다.
   * 다이어그램은 자기에게 속한(diagramUid) 유스케이스와 그 연결선만 그린다.
   * 소유자(owner)는 다이어그램이 아니라 **패키지**다 — EA가 그렇게 기대한다.
   */
  let dgmLocal = 1
  const packageDiagrams = pkgRefs.flatMap((ref) =>
    ref.diagrams.map((dr) => {
      const positions = resolveUseCasePositions(ref.pkg, dr.dgm, project)
      const actorPos = resolveActorPositions(ref.pkg, dr.dgm, project)
      const used = actorsUsedIn(ref.pkg, dr.dgm)
      const drawActors = project.settings.includeActorsInEachDiagram
        ? project.actors.filter((a) => used.has(a.uid))
        : []

      const elements: string[] = []
      let seq = 1

      drawActors.forEach((a) => {
        const p = actorPos.get(a.uid) ?? defaultActorPosition(0)
        elements.push(
          `${T(4)}<UML:DiagramElement geometry="Left=${p.x};Top=${p.y};Right=${p.x + 90};Bottom=${p.y + 100};" subject="${actorGuid.get(a.uid)}" seqno="${seq++}" style="DUID=${g.duid(`de:${dr.dgm.uid}:${a.uid}`)};"/>`
        )
      })

      /* 화면과 같은 타원 크기를 쓴다 — 작게 내보내면 EA 에서 이름이 타원 밖으로 넘친다 */
      const { w, h } = useCaseNodeSize(ref.pkg, dr.dgm, project)
      for (const uc of useCasesOf(ref.pkg, dr.dgm)) {
        const p = positions.get(uc.uid) as { x: number; y: number }
        elements.push(
          `${T(4)}<UML:DiagramElement geometry="Left=${p.x};Top=${p.y};Right=${p.x + w};Bottom=${p.y + h};" subject="${ucGuid.get(uc.uid)}" seqno="${seq++}" style="DUID=${g.duid(`de:${dr.dgm.uid}:${uc.uid}`)};"/>`
        )
      }

      for (const a of assocs.filter((x) => x.diagramUid === dr.dgm.uid)) {
        elements.push(
          `${T(4)}<UML:DiagramElement geometry="SX=0;SY=0;EX=0;EY=0;Path=;" subject="${a.id}" style="Mode=3;EOID=0;SOID=0;Color=-1;LWidth=0;Hidden=0;"/>`
        )
      }
      for (const d of deps.filter((x) => x.diagramUid === dr.dgm.uid)) {
        elements.push(
          `${T(4)}<UML:DiagramElement geometry="SX=0;SY=0;EX=0;EY=0;Path=;" subject="${d.id}" style="Mode=3;EOID=0;SOID=0;Color=-1;LWidth=0;Hidden=0;"/>`
        )
      }

      return diagramShell({
        name: diagramNameOf(ref.pkg, dr.dgm),
        id: dr.diagramId,
        ownerPackageId: ref.packageId,
        localId: dgmLocal++,
        elements
      })
    })
  )

  const actorsDiagram = diagramShell({
    name: 'Actors',
    id: g.eaid('diagram:actors'),
    ownerPackageId: actorsPkg.packageId,
    localId: 999,
    elements: project.actors.map((a, i) => {
      const p = a.position ?? defaultActorPosition(i)
      return `${T(4)}<UML:DiagramElement geometry="Left=${p.x};Top=${p.y};Right=${p.x + 90};Bottom=${p.y + 100};" subject="${actorGuid.get(a.uid)}" seqno="${i + 1}" style="DUID=${g.duid(`de:actors:${a.uid}`)};"/>`
    })
  })

  /* ================================================================== */
  /* 최종 조립                                                           */
  /* ================================================================== */

  const xml = `<?xml version="1.0" encoding="windows-1252"?>
<XMI xmi.version="1.1" xmlns:UML="omg.org/UML1.3" timestamp="${ts}">
${T(1)}<XMI.header>
${T(2)}<XMI.documentation>
${T(3)}<XMI.exporter>Enterprise Architect</XMI.exporter>
${T(3)}<XMI.exporterVersion>2.5</XMI.exporterVersion>
${T(2)}</XMI.documentation>
${T(1)}</XMI.header>
${T(1)}<XMI.content>
${T(2)}<UML:Model name="EA Model" xmi.id="${g.modelId('root')}">
${T(3)}<UML:Namespace.ownedElement>
${T(4)}<UML:Class name="EARootClass" xmi.id="${EA_ROOT_CLASS_ID}" isRoot="true" isLeaf="false" isAbstract="false"/>
${T(4)}<UML:Package name="Model" xmi.id="${modelPackageId}" isRoot="true" isLeaf="false" isAbstract="false" visibility="public">
${T(5)}<UML:ModelElement.taggedValue>
${tv(6, 'created', ts)}
${tv(6, 'modified', ts)}
${tv(6, 'iscontrolled', 'FALSE')}
${tv(6, 'isprotected', 'FALSE')}
${tv(6, 'usedtd', 'FALSE')}
${tv(6, 'logxml', 'FALSE')}
${tv(6, 'packageFlags', 'CRC=0;isModel=1;')}
${T(5)}</UML:ModelElement.taggedValue>
${T(5)}<UML:Namespace.ownedElement>
${T(6)}<UML:Collaboration xmi.id="${modelCollabId}" name="Collaborations">
${T(7)}<UML:Namespace.ownedElement>
${ucModelClassifierRole}
${T(7)}</UML:Namespace.ownedElement>
${T(7)}<UML:Collaboration.interaction/>
${T(6)}</UML:Collaboration>
${T(6)}<UML:Package name="Use Case Model" xmi.id="${ucModel.packageId}" isRoot="false" isLeaf="false" isAbstract="false" visibility="public">
${T(7)}<UML:ModelElement.taggedValue>
${tv(8, 'parent', modelPackageId)}
${tv(8, 'created', ts)}
${tv(8, 'modified', ts)}
${tv(8, 'iscontrolled', 'FALSE')}
${tv(8, 'version', '1.0')}
${tv(8, 'isprotected', 'FALSE')}
${tv(8, 'usedtd', 'FALSE')}
${tv(8, 'logxml', 'FALSE')}
${tv(8, 'packageFlags', 'isModel=1;VICON=1;')}
${tv(8, 'phase', '1.0')}
${tv(8, 'status', 'Proposed')}
${tv(8, 'complexity', '1')}
${tv(8, 'ea_stype', 'Public')}
${T(7)}</UML:ModelElement.taggedValue>
${T(7)}<UML:Namespace.ownedElement>
${T(8)}<UML:Collaboration xmi.id="${ucCollabId}" name="Collaborations">
${T(9)}<UML:Namespace.ownedElement>
${[actorsClassifierRole, ...pkgClassifierRoles].join('\n')}
${T(9)}</UML:Namespace.ownedElement>
${T(9)}<UML:Collaboration.interaction/>
${T(8)}</UML:Collaboration>
${actorsPackageXml}
${pkgRefs.map((ref, i) => ucdPackageXml(ref, i + 1)).join('\n')}
${[...associationXmls, ...dependencyXmls].join('\n')}
${T(7)}</UML:Namespace.ownedElement>
${T(6)}</UML:Package>
${T(5)}</UML:Namespace.ownedElement>
${T(4)}</UML:Package>
${T(3)}</UML:Namespace.ownedElement>
${T(2)}</UML:Model>
${ucTaggedValues.join('\n')}
${packageDiagrams.join('\n')}
${actorsDiagram}
${T(1)}</XMI.content>
${T(1)}<XMI.difference/>
${T(1)}<XMI.extensions xmi.extender="Enterprise Architect 2.5"/>
</XMI>
`

  return {
    xml,
    stats: {
      packages: pkgRefs.length,
      useCases: ucGuid.size,
      actors: project.actors.length,
      associations: assocs.length + deps.length,
      diagrams: packageDiagrams.length + 1
    }
  }
}

/** EA 요소 문서(documentation)에 요구사항 추적 정보를 함께 적는다 */
function buildDocumentation(uc: UseCase, pkg: UcPackage): string {
  const parts: string[] = []
  if (uc.description) parts.push(uc.description)
  if (uc.reqId || pkg.reqId) parts.push(`[요구사항] ${uc.reqId || pkg.reqId}`)
  if (uc.precondition) parts.push(`[사전조건] ${uc.precondition}`)
  if (uc.mainFlow) parts.push(`[기본 흐름]
${uc.mainFlow}`)
  if (uc.altFlow) parts.push(`[대체흐름]
${uc.altFlow}`)
  if (uc.exceptionFlow) parts.push(`[예외흐름]
${uc.exceptionFlow}`)
  if (uc.postcondition) parts.push(`[사후조건] ${uc.postcondition}`)
  if (uc.specialRequirement) parts.push(`[특별요구사항]
${uc.specialRequirement}`)
  if (uc.note) parts.push(`[비고] ${uc.note}`)
  return parts.join('\n\n')
}

export function formatTimestamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
